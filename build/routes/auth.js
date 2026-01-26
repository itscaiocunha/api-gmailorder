"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRoutes = authRoutes;
const zod_1 = require("zod");
const bcryptjs_1 = require("bcryptjs");
const server_1 = require("../server");
const loginBodySchema = zod_1.z.object({
    email: zod_1.z.string().email('Invalid email format'),
    password: zod_1.z.string().min(6, 'Password must be at least 6 characters'),
});
const createUserBodySchema = zod_1.z.object({
    name: zod_1.z.string().optional(),
    email: zod_1.z.string().email('Invalid email format'),
    password: zod_1.z.string().min(6, 'Password must be at least 6 characters'),
});
async function authRoutes(app) {
    const appZod = app.withTypeProvider();
    appZod.post('/login', {
        schema: {
            tags: ['Login'],
            summary: 'Login do usuário',
            body: loginBodySchema,
            response: {
                200: zod_1.z.object({
                    message: zod_1.z.string(),
                    token: zod_1.z.string(),
                }),
                401: zod_1.z.object({ message: zod_1.z.string() }),
            },
        },
    }, async (request, reply) => {
        const { email, password } = request.body;
        const { data: user, error } = await server_1.supabase
            .from('users')
            .select('id, email, password')
            .eq('email', email)
            .single();
        if (error || !user) {
            return reply.status(401).send({ message: 'Invalid credentials or user not found.' });
        }
        const passwordMatch = await (0, bcryptjs_1.compare)(password, user.password);
        if (!passwordMatch) {
            return reply.status(401).send({ message: 'Invalid credentials.' });
        }
        const token = await reply.jwtSign({ userId: user.id }, { sign: { expiresIn: '7d' } });
        reply.setCookie('auth_token', token, {
            path: '/',
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 60 * 60 * 24 * 7,
        });
        return reply.status(200).send({
            message: 'Login successful',
            token,
        });
    });
    appZod.post('/users', {
        schema: {
            tags: ['Cadastro'],
            summary: 'Criação de um novo acesso',
            body: createUserBodySchema,
            response: {
                201: zod_1.z.object({
                    userId: zod_1.z.string().uuid('The returned ID is not a valid UUID'),
                }),
                409: zod_1.z.object({ message: zod_1.z.string() }),
            },
        },
    }, async (request, reply) => {
        const { name, email, password } = request.body;
        const { data: existingUser } = await server_1.supabase
            .from('users')
            .select('id')
            .eq('email', email)
            .single();
        if (existingUser) {
            return reply.status(409).send({ message: 'User with this email already exists.' });
        }
        const password_hash = await (0, bcryptjs_1.hash)(password, 8);
        const { data, error } = await server_1.supabase
            .from('users')
            .insert({
            name,
            email,
            password: password_hash,
        })
            .select('id')
            .single();
        if (error || !data) {
            console.error('Supabase Error:', error);
            return reply.status(409).send({ message: 'Failed to create user.' });
        }
        const { id } = data;
        return reply.status(201).send({
            userId: data.id,
        });
    });
}
