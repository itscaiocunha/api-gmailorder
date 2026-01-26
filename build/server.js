"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.supabase = void 0;
exports.default = handler;
require("dotenv/config");
const fastify_1 = __importDefault(require("fastify"));
const fastify_type_provider_zod_1 = require("fastify-type-provider-zod");
const cors_1 = __importDefault(require("@fastify/cors"));
const swagger_1 = __importDefault(require("@fastify/swagger"));
const jwt_1 = __importDefault(require("@fastify/jwt"));
const cookie_1 = __importDefault(require("@fastify/cookie"));
const auth_1 = require("./routes/auth");
const supabase_js_1 = require("@supabase/supabase-js");
exports.supabase = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const app = (0, fastify_1.default)({
    logger: true,
}).withTypeProvider();
app.setValidatorCompiler(fastify_type_provider_zod_1.validatorCompiler);
app.setSerializerCompiler(fastify_type_provider_zod_1.serializerCompiler);
const registerPlugins = async () => {
    await app.register(cors_1.default, {
        origin: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        credentials: true,
    });
    await app.register(swagger_1.default, {
        openapi: {
            info: {
                title: 'HellaShipping API',
                description: 'API da plataforma de gerenciamento de e-mails.',
                version: '1.0.0',
            },
        },
        transform: fastify_type_provider_zod_1.jsonSchemaTransform,
    });
    await app.register(import('@scalar/fastify-api-reference'), {
        routePrefix: '/docs',
    });
    await app.register(jwt_1.default, {
        secret: process.env.JWT_SECRET,
        cookie: {
            cookieName: 'auth_token',
            signed: false,
        },
        sign: {
            expiresIn: '7d',
        },
    });
    await app.register(cookie_1.default);
    await app.register(auth_1.authRoutes);
};
registerPlugins();
async function handler(req, res) {
    await app.ready();
    app.server.emit('request', req, res);
}
if (process.env.NODE_ENV !== 'production' && require.main === module) {
    const start = async () => {
        try {
            await app.ready();
            await app.listen({
                port: Number(process.env.PORT) || 3333,
                host: '0.0.0.0'
            });
            console.log(`\n🚀 HTTP Server Running on http://localhost:3333`);
            console.log(`📘 Docs available at http://localhost:3333/docs\n`);
        }
        catch (err) {
            app.log.error(err);
            process.exit(1);
        }
    };
    start();
}
