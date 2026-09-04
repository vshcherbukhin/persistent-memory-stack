/** Startup routing for Personal Memories and the optional Shared connector. */
import { ApiClient, log, requireTokenForServerMode, resolveRuntime, } from '@pm/mcp-runtime';
function apiClientFor(cfg, apiUrl, token) {
    return new ApiClient({
        ...cfg,
        API_URL: apiUrl,
        PM_USER_TOKEN: token,
    });
}
function requireTokenForResolvedRuntime(runtime, token) {
    if (runtime.deploymentMode === 'local')
        return;
    requireTokenForServerMode({
        PM_USER_TOKEN: token,
        API_URL: 'http://localhost:8090',
        OLLAMA_URL: 'http://localhost:11434',
        EMBED_PROVIDER: 'ollama',
        PM_API_TIMEOUT_MS: 60_000,
        PM_MCP_TRANSPORT: 'http',
        PM_MCP_CLIENT_NAME: 'persistent-memory-mcp',
        PM_MCP_HTTP_HOST: '127.0.0.1',
        PM_MCP_HTTP_PORT: 8091,
        PM_MEMORY_INSTALL_MODE: 'shared-only',
        PM_DEFAULT_MEMORY_SURFACE: 'shared',
    });
}
async function loadStoredSharedConnection(personalApi) {
    try {
        const status = await personalApi.get('/dashboard/shared-connection', { includeToken: true });
        if (!status.configured || !status.apiUrl || !status.token)
            return null;
        return { apiUrl: status.apiUrl, token: status.token };
    }
    catch (err) {
        log.warn('shared memory connection lookup failed; continuing with personal memory only', {
            err: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}
async function resolveSharedContext(cfg, personalApi) {
    const stored = await loadStoredSharedConnection(personalApi);
    const sharedApiUrl = stored?.apiUrl ?? cfg.PM_SHARED_API_URL;
    const sharedToken = stored?.token ?? cfg.PM_SHARED_USER_TOKEN ?? cfg.PM_USER_TOKEN;
    if (!sharedApiUrl || !sharedToken)
        return null;
    const sharedApi = apiClientFor(cfg, sharedApiUrl, sharedToken);
    const sharedRuntime = await resolveRuntime(sharedApi, cfg);
    requireTokenForResolvedRuntime(sharedRuntime, sharedToken);
    return { api: sharedApi, runtime: sharedRuntime };
}
export async function resolveStartupContext(cfg) {
    if (cfg.PM_MEMORY_INSTALL_MODE === 'shared-only') {
        const api = new ApiClient(cfg);
        const runtime = await resolveRuntime(api, cfg);
        requireTokenForResolvedRuntime(runtime, cfg.PM_USER_TOKEN);
        return { api, runtime };
    }
    const personalApiUrl = cfg.PM_PERSONAL_API_URL ?? cfg.API_URL;
    const personalApi = apiClientFor(cfg, personalApiUrl, cfg.PM_PERSONAL_USER_TOKEN);
    const personalRuntime = await resolveRuntime(personalApi, cfg);
    requireTokenForResolvedRuntime(personalRuntime, cfg.PM_PERSONAL_USER_TOKEN);
    if (cfg.PM_MEMORY_INSTALL_MODE === 'personal-only') {
        // Personal-only is a hard routing boundary. Do not inspect a stored or
        // legacy environment Shared connector: it must not influence MCP tools.
        return {
            api: personalApi,
            runtime: {
                ...personalRuntime,
                memorySurfaces: {
                    defaultSurface: 'personal',
                    personal: { api: personalApi, runtime: personalRuntime },
                },
            },
        };
    }
    const shared = await resolveSharedContext(cfg, personalApi);
    if (!shared) {
        log.error('personal-and-shared mode requires a saved or environment-provided shared connection');
        process.exit(1);
    }
    const defaultSurface = cfg.PM_DEFAULT_MEMORY_SURFACE;
    const defaultCtx = defaultSurface === 'shared'
        ? shared
        : { api: personalApi, runtime: personalRuntime };
    return {
        api: defaultCtx.api,
        runtime: {
            ...defaultCtx.runtime,
            memorySurfaces: {
                defaultSurface,
                personal: { api: personalApi, runtime: personalRuntime },
                shared,
            },
        },
    };
}
//# sourceMappingURL=startup.js.map