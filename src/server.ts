import 'dotenv/config'
import fastify, { FastifyInstance } from 'fastify'
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from 'fastify-type-provider-zod'
import fastifyCors from '@fastify/cors'
import fastifySwagger from '@fastify/swagger'
import fastifyJwt from '@fastify/jwt'
import fastifyCookie from '@fastify/cookie'
// import path from 'path' <--- Não precisa mais disso

import { authRoutes } from './routes/auth'
import { gmailRoutes } from './routes/gmail'
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
)

let app: FastifyInstance | null = null;

async function buildApp() {
  const server = fastify({
    logger: true,
    disableRequestLogging: false
  }).withTypeProvider<ZodTypeProvider>()

  server.setValidatorCompiler(validatorCompiler)
  server.setSerializerCompiler(serializerCompiler)

  await server.register(fastifyCors, {
    origin: true, 
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  })

  await server.register(fastifyJwt, {
    secret: process.env.JWT_SECRET!,
    cookie: {
      cookieName: 'auth_token',
      signed: false,
    },
    sign: {
      expiresIn: '7d',
    },
  })

  await server.register(fastifyCookie)

  if (process.env.NODE_ENV !== 'production') {
    await server.register(fastifySwagger, {
      openapi: {
        info: {
          title: 'HellaShipping API',
          description: 'API da plataforma de gerenciamento de e-mails.',
          version: '1.0.0',
        },
      },
      transform: jsonSchemaTransform,
    })

    await server.register(import('@scalar/fastify-api-reference'), {
      routePrefix: '/docs',
    })
    
    console.log('📖 Documentation loaded (Development only)')
  }

  // --- REGISTRO DE ROTAS ---
  await server.register(authRoutes)
  await server.register(gmailRoutes)

  return server;
}

export default async function handler(req: any, res: any) {
  if (!app) {
    app = await buildApp();
    await app.ready();
  }
  app.server.emit('request', req, res);
}

if (process.env.NODE_ENV !== 'production' && require.main === module) {
  buildApp().then(async (server) => {
    try {
      await server.ready();
      await server.listen({ 
        port: Number(process.env.PORT) || 3333, 
        host: '0.0.0.0' 
      })
      console.log(`\n🚀 HTTP Server Running locally`)
    } catch (err) {
      console.error(err)
      process.exit(1)
    }
  });
}