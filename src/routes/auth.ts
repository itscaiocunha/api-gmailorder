import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { compare, hash } from 'bcryptjs'
import { supabase } from '../server'

const loginBodySchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
})

const createUserBodySchema = z.object({
  name: z.string().optional(),
  email: z.string().email('Invalid email format'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
})

export async function authRoutes(app: FastifyInstance) {
  const appZod = app.withTypeProvider<ZodTypeProvider>()

  appZod.post('/login', {
    schema: {
      tags: ['Login'],
      summary: 'Login do usuário',
      body: loginBodySchema,
      response: {
        200: z.object({
          message: z.string(),
          token: z.string(),
        }),
        401: z.object({ message: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { email, password } = request.body

    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, password')
      .eq('email', email)
      .single()

    if (error || !user) {
      return reply.status(401).send({ message: 'Invalid credentials or user not found.' })
    }

    const passwordMatch = await compare(password, user.password)

    if (!passwordMatch) {
      return reply.status(401).send({ message: 'Invalid credentials.' })
    }

    const token = await reply.jwtSign(
      { userId: user.id },
      { sign: { expiresIn: '7d' } }
    )

    reply.setCookie('auth_token', token, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 7,
    })

    return reply.status(200).send({
      message: 'Login successful',
      token,
    })
  })

  appZod.post('/users', {
    schema: {
      tags: ['Cadastro'],
      summary: 'Criação de um novo acesso',
      body: createUserBodySchema,
      response: {
        201: z.object({
          userId: z.string().uuid('The returned ID is not a valid UUID'),
        }),
        409: z.object({ message: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { name, email, password } = request.body

    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single()

    if (existingUser) {
      return reply.status(409).send({ message: 'User with this email already exists.' })
    }
    
    const password_hash = await hash(password, 8)
    
    const { data, error } = await supabase
      .from('users')
      .insert({ 
        name, 
        email, 
        password: password_hash,
      })
      .select('id')
      .single()

    if (error || !data) {
      console.error('Supabase Error:', error)
      return reply.status(409).send({ message: 'Failed to create user.' })
    }

    const { id } = data;

    return reply.status(201).send({
      userId: data.id as string, 
    })
  })
}