import type { RemoteProvider } from '../shared/types';

export const providerName = (provider: RemoteProvider | 'chatgpt') =>
    provider === 'chatgpt' ? 'ChatGPT' : provider === 'openai' ? 'OpenAI' : 'Anthropic';

// Never forward SDK errors wholesale: they can contain headers, keys, or request
// bodies. Classify structured status/codes, including errors nested in SSE streams.
export function providerError(provider: RemoteProvider | 'chatgpt', error: unknown) {
    const name = providerName(provider);
    const records: Record<string, unknown>[] = [];
    const visit = (value: unknown, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 5 || records.length >= 24) return;
        const record = value as Record<string, unknown>;
        if (records.includes(record)) return;
        records.push(record);
        visit(record.cause, depth + 1);
        visit(record.error, depth + 1);
        if (Array.isArray(record.errors)) for (const child of record.errors) visit(child, depth + 1);
    };
    visit(error);
    const has = (...values: string[]) =>
        records.some(
            record =>
                values.includes(String(record.code)) ||
                values.includes(String(record.type)) ||
                values.includes(String(record.name)) ||
                values.includes((record.constructor as { name?: string } | undefined)?.name ?? ''),
        );
    const status = records.map(record => record.status).find(value => typeof value === 'number') as number | undefined;
    const parameter = records
        .map(record => record.param)
        .find(value => typeof value === 'string' && /^[a-z_][a-z0-9_.\[\]]{0,70}$/.test(value));
    const field = parameter ? ` Parameter: ${parameter}.` : '';
    if (provider === 'chatgpt') {
        if (has('subscription_sharing_usage_limit_exceeded') || status === 429)
            return new Error(
                'ChatGPT usage limit reached. Open Manage usage to review your plan or this app’s limit. No paid API fallback was attempted.',
            );
        if (has('subscription_sharing_user_not_eligible'))
            return new Error(
                'ChatGPT plan usage is unavailable for this account, workspace, or policy. Choose another connection in Settings.',
            );
        if (has('subscription_sharing_unsupported_capability'))
            return new Error(
                `This capability is not supported by ChatGPT plan usage.${field} Try a supported model or mode.`,
            );
        if (status === 401 || has('subscription_sharing_invalid_user'))
            return new Error(
                'ChatGPT did not accept this account’s authorization. Check the selected account and reconnect in Connections.',
            );
        if (
            status === 403 ||
            has(
                'subscription_sharing_route_not_supported',
                'chatpass_v2_scope_not_authorized',
                'chatpass_v2_invalid_authorization_context',
            )
        )
            return new Error(
                'ChatGPT plan access was denied by an account, region, or permission policy. Check the connection and ChatGPT settings.',
            );
        if (
            (status && status >= 500) ||
            has('subscription_sharing_usage_unavailable', 'subscription_sharing_user_unavailable')
        )
            return new Error(
                'ChatGPT plan usage is temporarily unavailable. Try again later; your connection has been preserved.',
            );
    }
    if (has('insufficient_quota', 'billing_hard_limit_reached', 'credit_balance_too_low'))
        return new Error(
            `${name} API credits or spending limit exhausted. Check API billing for this key's project; signing into a subscription does not resolve this API error.`,
        );
    if (status === 401 || has('invalid_api_key', 'authentication_error'))
        return new Error(`${name} rejected the API key. Update it in Connections.`);
    if (
        status === 403 ||
        status === 404 ||
        has('model_not_found', 'permission_denied', 'permission_error', 'not_found_error')
    )
        return new Error(
            `${name} denied access to this model or endpoint${status ? ` (HTTP ${status})` : ''}. Check the selected model and this API project's permissions.`,
        );
    if (status === 429 || has('rate_limit_exceeded', 'rate_limit_error'))
        return new Error(`${name} API rate limit reached. Wait before retrying and check your API usage limits.`);
    if (has('ENOTFOUND', 'EAI_AGAIN'))
        return new Error(
            `${name} hostname lookup failed (DNS). Check the connection or DNS settings; no API response was received.`,
        );
    if (
        has(
            'CERT_HAS_EXPIRED',
            'DEPTH_ZERO_SELF_SIGNED_CERT',
            'SELF_SIGNED_CERT_IN_CHAIN',
            'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
            'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
            'ERR_TLS_CERT_ALTNAME_INVALID',
        )
    )
        return new Error(
            `${name} TLS certificate verification failed. Check the system clock, trusted certificates, or HTTPS proxy. Certificate verification remains enabled.`,
        );
    if (
        has(
            'APIConnectionTimeoutError',
            'TimeoutError',
            'ETIMEDOUT',
            'UND_ERR_CONNECT_TIMEOUT',
            'UND_ERR_HEADERS_TIMEOUT',
            'UND_ERR_BODY_TIMEOUT',
        )
    )
        return new Error(
            `${name} request timed out. It may still have reached the provider; check your connection and retry manually.`,
        );
    if (has('ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'EPIPE'))
        return new Error(
            `${name} network connection was refused or interrupted. Check the connection, firewall, or proxy. A sent request may still be billed.`,
        );
    if (
        status === 400 ||
        status === 422 ||
        has('invalid_request_error', 'unsupported_parameter', 'invalid_value', 'context_length_exceeded')
    )
        return new Error(
            `${name} rejected the request${status ? ` (HTTP ${status})` : ''}.${field} Check this model's input, tool, and context support.`,
        );
    if ((status && status >= 500) || has('server_error', 'overloaded_error', 'api_error'))
        return new Error(
            `${name} service returned an error${status ? ` (HTTP ${status})` : ''}. Try again later; your API key has not been removed.`,
        );
    if (has('APIConnectionError'))
        return new Error(
            `${name} could not establish the API connection. No HTTP response was received. Check network, proxy and certificate settings.`,
        );
    if (has('SyntaxError'))
        return new Error(
            `${name} returned an unreadable response stream. This may be a truncated response or an intermediary replacing the API response.`,
        );
    return new Error(
        `${name} response could not be processed${status ? ` (HTTP ${status})` : ''}. The failure was not identified as an authentication error; it may be a stream or adapter error.`,
    );
}
