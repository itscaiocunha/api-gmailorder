import { authenticate } from '@google-cloud/local-auth';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { supabase } from '../server'; // Importa do seu server.ts

// --- CONFIGURAÇÕES ---
const SCOPES: string[] = ['https://www.googleapis.com/auth/gmail.readonly'];
const PADRAO_CODIGO = /[A-Z]-\d+\/\d{2}/; 
const EXTENSOES_PERMITIDAS = ['.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls'];

interface AnexoInfo {
  filename: string;
  attachmentId: string;
  mimeType: string;
}

// --- AUTH VIA VARIAVEIS DE AMBIENTE (VERCEL) ---
async function getAuthenticatedClient(): Promise<OAuth2Client> {
  // Tenta pegar das variáveis de ambiente primeiro (Produção)
  const credentialsJson = process.env.GOOGLE_CREDENTIALS;
  const tokenJson = process.env.GOOGLE_TOKEN;

  if (!credentialsJson || !tokenJson) {
    throw new Error("Credenciais do Google não configuradas no .env (GOOGLE_CREDENTIALS / GOOGLE_TOKEN)");
  }

  const keys = JSON.parse(credentialsJson);
  const tokens = JSON.parse(tokenJson);
  const key = keys.installed || keys.web;

  const client = new google.auth.OAuth2(key.client_id, key.client_secret, key.redirect_uris[0]);
  client.setCredentials(tokens);
  return client;
}

// --- HELPERS DE TEXTO E ANEXO (Mantidos, só removendo FS) ---
function extrairTextoRecursivo(parts: any[]): string {
  let parte = parts.find((p: any) => p.mimeType === 'text/plain');
  if (!parte) parte = parts.find((p: any) => p.mimeType === 'text/html');
  if (parte && parte.body && parte.body.data) {
    return Buffer.from(parte.body.data, 'base64url').toString('utf-8');
  }
  for (const subPart of parts) {
    if (subPart.parts) {
      const t = extrairTextoRecursivo(subPart.parts);
      if (t) return t;
    }
  }
  return '';
}

function encontrarAnexos(parts: any[]): AnexoInfo[] {
  let arr: AnexoInfo[] = [];
  for (const part of parts) {
    if (part.filename && part.body && part.body.attachmentId) {
      arr.push({ filename: part.filename, attachmentId: part.body.attachmentId, mimeType: part.mimeType });
    }
    if (part.parts) arr = arr.concat(encontrarAnexos(part.parts));
  }
  return arr;
}

// --- ATUALIZAR METADATA NO SUPABASE ---
async function atualizarJobNoSupabase(jobId: string, dadosEmail: any, novosAnexos: string[], folderName: string) {
  // 1. Busca o Job atual
  const { data: existing } = await supabase.from('jobs').select('*').eq('id', jobId).single();

  let meta = existing?.metadata || {
    jobId,
    folderName,
    emailCount: 0,
    attachments: [],
    emails: []
  };

  // 2. Atualiza se o e-mail for novo
  if (!meta.emails.find((e: any) => e.id === dadosEmail.id)) {
    meta.emails.push(dadosEmail);
    meta.emailCount += 1;
    meta.lastUpdate = new Date().toISOString();
    meta.attachments = [...new Set([...meta.attachments, ...novosAnexos])];

    // 3. Salva no Banco
    await supabase.from('jobs').upsert({
      id: jobId,
      folder_name: folderName,
      last_update: new Date().toISOString(),
      email_count: meta.emailCount,
      status: jobId.startsWith('THREAD') ? 'Pending' : 'Active',
      metadata: meta
    });
  }
}

// --- WORKER ---
export async function executarSyncGmail() {
  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });

    console.log('🔄 Vercel Worker: Buscando e-mails...');
    const res = await gmail.users.messages.list({ userId: 'me', q: 'is:unread', maxResults: 10 }); // Reduzido para Vercel não dar timeout
    const messages = res.data.messages;

    if (!messages || messages.length === 0) {
      return { status: 'success', message: 'Nenhum e-mail novo.' };
    }

    let processados = 0;

    for (const message of messages) {
      if (!message.id) continue;

      const detalhes = await gmail.users.messages.get({ userId: 'me', id: message.id, format: 'full' });
      const payload = detalhes.data.payload;
      if (!payload) continue;

      const headers = payload.headers;
      const assunto = headers?.find((h: any) => h.name === 'Subject')?.value || '(Sem Assunto)';
      const remetente = headers?.find((h: any) => h.name === 'From')?.value || '(Desconhecido)';
      const dataEmail = headers?.find((h: any) => h.name === 'Date')?.value || new Date().toISOString();
      const threadId = detalhes.data.threadId || message.id;

      // Identifica Job
      const match = assunto.match(PADRAO_CODIGO);
      const codigoJob = match ? match[0] : null;
      const jobId = codigoJob ? `JOB_${codigoJob.replace('/', '_')}` : `THREAD_${threadId}`;
      const folderName = codigoJob ? codigoJob : `OUTROS/${threadId}`;

      // 1. Processa Corpo
      let corpoTexto = '';
      if (payload.body?.data) corpoTexto = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
      else if (payload.parts) corpoTexto = extrairTextoRecursivo(payload.parts);

      // Upload do Texto para o Storage
      const pathTexto = `${jobId}/email_${message.id}.txt`;
      await supabase.storage.from('emails').upload(pathTexto, `DATA: ${dataEmail}\nDE: ${remetente}\nASSUNTO: ${assunto}\n\n${corpoTexto}`, { upsert: true });

      // 2. Processa Anexos
      let anexos: AnexoInfo[] = [];
      if (payload.parts) anexos = encontrarAnexos(payload.parts);
      
      const anexosDocs = anexos.filter(a => {
        const ext = a.filename.split('.').pop()?.toLowerCase() || '';
        return EXTENSOES_PERMITIDAS.includes('.' + ext);
      });

      const nomesAnexosSalvos: string[] = [];

      for (const anexo of anexosDocs) {
        const nomeSeguro = anexo.filename.replace(/[/\\?%*:|"<>]/g, '-');
        const nomeFinal = `${message.id}_${nomeSeguro}`;
        
        const anexoData = await gmail.users.messages.attachments.get({
          userId: 'me', messageId: message.id, id: anexo.attachmentId
        });

        if (anexoData.data.data) {
          const buffer = Buffer.from(anexoData.data.data, 'base64url');
          const pathAnexo = `${jobId}/${nomeFinal}`;
          
          // Upload Anexo
          const { error } = await supabase.storage.from('emails').upload(pathAnexo, buffer, { 
            contentType: anexo.mimeType,
            upsert: true 
          });
          
          if (!error) nomesAnexosSalvos.push(nomeFinal);
        }
      }

      // 3. Atualiza DB
      await atualizarJobNoSupabase(
        jobId, 
        {
          id: message.id,
          from: remetente,
          subject: assunto,
          date: dataEmail,
          snippet: detalhes.data.snippet,
          // O corpo será buscado do storage depois, ou podemos salvar no JSON se for pequeno.
          // Para simplificar, não vamos salvar o body gigante no JSON do banco.
        },
        nomesAnexosSalvos,
        folderName
      );

      processados++;
    }

    return { status: 'success', message: `${processados} processados via Supabase.` };

  } catch (error: any) {
    console.error(error);
    throw new Error(error.message);
  }
}

// Função stub para manter compatibilidade com a rota de cancelamento (Serverless não cancela fácil)
export function cancelarSyncGmail() { return false; }