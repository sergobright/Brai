import { zod } from '../third_party/index.js';
import { ToolCategory } from './categories.js';
import { definePageTool } from './ToolDefinition.js';
import { applyCaddyAuthentication } from './caddy-auth-policy.js';

const defaultCredentialFile = ['', 'home', 'mark', '.server-secrets', 'caddy-basic-auth-admin.txt'].join('/');
const credentialFile = defaultCredentialFile;

export const caddyBasicAuth = definePageTool({
  name: 'caddy_basic_auth',
  description: 'Applies or clears the workspace Caddy Basic Auth credentials for the selected protected Brai page.',
  annotations: { category: ToolCategory.NAVIGATION, readOnlyHint: false },
  schema: {
    action: zod.enum(['apply', 'clear']),
    url: zod.string().url().optional().describe('Optional allowlisted HTTPS Brai URL to open after applying credentials.'),
  },
  blockedByDialog: true,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const result = await applyCaddyAuthentication(request.page.pptrPage, request.params.action, credentialFile, request.params.url);
    response.appendResponseLine(`Caddy authentication ${result.action} completed for ${result.host}.`);
  },
});
