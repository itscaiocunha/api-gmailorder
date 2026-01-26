import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import z from 'zod'
import { executarSyncGmail } from '../services/gmailWorker'
import { supabase } from '../server' // Importa client supabase

export async function gmailRoutes(app: FastifyInstance) {
  
  // 1. DASHBOARD: Lista Jobs e resumo da Triagem
  app.withTypeProvider<ZodTypeProvider>().get('/jobs', {
    schema: {
      tags: ['Gmail'],
      summary: 'Lista Jobs e resumo da Triagem',
      response: {
        200: z.object({
          jobs: z.array(z.any()), // Lista de Jobs
          triageSummary: z.object({ // Resumo da caixa 'Outros'
            totalThreads: z.number(),
            totalEmails: z.number(),
            totalAttachments: z.number()
          })
        }),
        500: z.any()
      }
    }
  }, async (request, reply) => {
    // A. Busca Jobs Oficiais (JOB_*)
    const { data: jobs } = await supabase
      .from('jobs')
      .select('metadata')
      .ilike('id', 'JOB_%')
      .order('last_update', { ascending: false });

    // B. Busca Threads de Triagem (THREAD_*)
    // Elas ficam "escondidas" no dashboard principal e só aparecem no resumo
    const { data: threads } = await supabase
      .from('jobs')
      .select('metadata')
      .ilike('id', 'THREAD_%');
    
    let totalEmails = 0, totalAttachments = 0;
    
    // Calcula totais para o card de alerta
    threads?.forEach((t: any) => {
      totalEmails += t.metadata.emailCount || 0;
      totalAttachments += (t.metadata.attachments || []).length;
    });

    return {
      jobs: jobs?.map(j => j.metadata) || [],
      triageSummary: {
        totalThreads: threads?.length || 0, // Quantas conversas existem
        totalEmails,
        totalAttachments
      }
    };
  })

  // 2. TRIAGEM: Lista detalhada apenas das pendências
  app.withTypeProvider<ZodTypeProvider>().get('/triage', {
    schema: {
      tags: ['Gmail'],
      summary: 'Lista todas as threads pendentes de triagem',
      response: {
        200: z.array(z.any()),
        500: z.any()
      }
    }
  }, async (request, reply) => {
    const { data } = await supabase
      .from('jobs')
      .select('metadata')
      .ilike('id', 'THREAD_%') // Pega tudo que não é Job oficial
      .order('last_update', { ascending: false });
    
    // Adiciona flag para o front saber que é thread
    return data?.map(d => ({ ...d.metadata, isThread: true })) || [];
  })

  // 3. DETALHES: Busca dados de um Job ou Thread Específica
  // Aceita ID direto (ex: JOB_123) ou composto (ex: OUTROS/THREAD_456)
  app.withTypeProvider<ZodTypeProvider>().get('/jobs/:id', {
    schema: {
      tags: ['Gmail'],
      params: z.object({
        id: z.string()
      }),
      response: {
        200: z.any(),
        404: z.object({ message: z.string() }),
        500: z.any()
      }
    }
  }, async (req, reply) => {
    let dbId = req.params.id;
    
    // Limpeza: O frontend pode mandar "OUTROS/THREAD_XYZ"
    // A gente precisa extrair só o ID real que está no banco ("THREAD_XYZ")
    if (dbId.includes('THREAD_')) {
       const parts = dbId.split('/');
       // Pega a parte que começa com THREAD_
       dbId = parts.find((p: string) => p.startsWith('THREAD_')) || dbId;
    }

    // Se o ID for só "OUTROS", o usuário quer ver TODOS os não categorizados juntos?
    // Se sim, precisaríamos de uma lógica diferente. 
    // Mas pela sua solicitação anterior, "OUTROS" era uma pasta única.
    // Se você reverteu para pasta única, o ID no banco será 'OUTROS'.
    // Se manteve threads separadas, o ID será 'THREAD_XXX'.
    
    const { data, error } = await supabase
      .from('jobs')
      .select('metadata')
      .eq('id', dbId)
      .single();

    if (error || !data) {
      return reply.status(404).send({ message: 'Job/Thread não encontrado' });
    }

    const meta = data.metadata;

    // Hidratação: Busca o conteúdo de texto de cada e-mail no Storage
    // Isso evita trafegar o corpo do e-mail na listagem principal
    const emailsComCorpo = await Promise.all(meta.emails.map(async (email: any) => {
      try {
        // O caminho no storage segue o padrão: ID_DO_JOB/email_ID_MSG.txt
        const path = `${dbId}/email_${email.id}.txt`;
        
        const { data: fileData } = await supabase.storage.from('emails').download(path);
        
        if (fileData) {
           const text = await fileData.text();
           // O arquivo txt tem cabeçalhos (DE, DATA, ASSUNTO). 
           // O corpo real geralmente vem depois de duas quebras de linha.
           const parts = text.split('\n\n');
           return { ...email, body: parts.length > 1 ? parts.slice(1).join('\n\n') : text };
        }
        return email;
      } catch { 
        return email; 
      }
    }));

    meta.emails = emailsComCorpo;
    return meta;
  })

  // 4. SYNC: Dispara o Worker
  app.withTypeProvider<ZodTypeProvider>().post('/sync', {
    schema: {
      tags: ['Gmail'],
      summary: 'Inicia sincronização',
      response: {
        200: z.object({ status: z.string(), message: z.string() }),
        500: z.any()
      }
    }
  }, async (request, reply) => {
    try {
      return await executarSyncGmail();
    } catch (e: any) {
      return reply.status(500).send({ status: 'error', message: e.message });
    }
  })

  // 5. CANCEL: Endpoint placeholder (Serverless não cancela fácil)
  app.withTypeProvider<ZodTypeProvider>().post('/sync/cancel', async () => ({ 
    message: 'Cancelamento não suportado em ambiente serverless.' 
  }));
}