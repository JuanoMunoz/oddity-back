import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from './db';
import { admin, openAPI, createAccessControl } from 'better-auth/plugins';

const ac = createAccessControl({
  organization: ['create', 'read', 'update', 'delete'],
  user: ['create', 'read', 'update', 'delete', 'list', 'set-role'],
  iaModel: ['create', 'read', 'update', 'delete'],
  customAgent: ['create', 'read', 'update', 'delete'],
});

export const roles = {
  user: ac.newRole({
    organization: ['read'],
    iaModel: ['read'],
    customAgent: ['read'],
  }),
  admin: ac.newRole({
    organization: ['create', 'read', 'update', 'delete'],
    user: ['create', 'read', 'update', 'list'],
    iaModel: ['create', 'read', 'update', 'delete'],
    customAgent: ['create', 'read', 'update', 'delete'],
  }),
  superadmin: ac.newRole({
    organization: ['create', 'read', 'update', 'delete'],
    user: ['create', 'read', 'update', 'delete', 'list', 'set-role'],
    iaModel: ['create', 'read', 'update', 'delete'],
    customAgent: ['create', 'read', 'update', 'delete'],
  }),
};

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
  }),
  trustHost: true,

  cookies: {
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    secure: process.env.NODE_ENV === 'production',
  },
  advanced: {
    // Disabled as frontend and backend are on different domains (vercel.app vs onrender.com)
    crossSubDomainCookies: {
      enabled: false,
    },
  },

  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:3000',
  emailAndPassword: {
    enabled: true,
  },
  trustedOrigins: [
    process.env.BASE_URL_FRONTEND,
    'http://localhost:5173',
    'https://oddity-front.vercel.app',
    ...(process.env.TRUSTED_ORIGINS
      ? process.env.TRUSTED_ORIGINS.split(',')
      : []),
  ].filter((origin): origin is string => !!origin),

  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
    microsoft: {
      clientId: process.env.MICROSOFT_CLIENT_ID!,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
    },
  },
  user: {
    additionalFields: {
      organizationId: { type: 'number' },
    },
  },
  plugins: [
    openAPI(),
    admin({
      ac,
      roles,
      defaultRole: 'user',
      adminRoles: ['admin', 'superadmin'],
    }),
  ],
});
