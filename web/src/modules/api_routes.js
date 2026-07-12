// @ts-check
(function() {
    'use strict';

    const API_VERSION_PREFIX = '/api';
    const apiRoute = (path) => `${API_VERSION_PREFIX}${path}`;

    const API_ROUTES = Object.freeze({
        devices: {
            list: apiRoute('/devices'),
            byId: (id) => apiRoute(`/devices/${encodeURIComponent(id)}`),
            approve: apiRoute('/devices/approve'),
            publicByUser: (username) => apiRoute(`/users/${encodeURIComponent(username)}/devices`),
        },
        vault: {
            events: apiRoute('/vault/events'),
        },
        keyEnvelopes: {
            list: (deviceId = '') => apiRoute(`/key-envelopes${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''}`),
            base: apiRoute('/key-envelopes'),
        },
        historyTickets: apiRoute('/history-tickets'),
        discover: {
            servers: apiRoute('/discover/servers'),
        },
        auth: {
            me: apiRoute('/auth/me'),
            register: apiRoute('/auth/register'),
            login: apiRoute('/auth/login'),
            wsTicket: apiRoute('/auth/ws-ticket'),
        },
        contacts: {
            list: apiRoute('/contacts'),
            byUsername: (username) => apiRoute(`/contacts/${encodeURIComponent(username)}`),
        },
        users: {
            search: (query) => apiRoute(`/users?q=${encodeURIComponent(query)}`),
        },
        avatar: {
            base: apiRoute('/avatar'),
            byUsername: (username) => apiRoute(`/avatar/${encodeURIComponent(username)}`),
        },
        invites: {
            join: (code) => apiRoute(`/invites/${encodeURIComponent(code)}/join`),
        },
        messages: {
            direct: (user) => apiRoute(`/messages/${encodeURIComponent(user)}`),
            reaction: (id) => apiRoute(`/message/${encodeURIComponent(id)}/reaction`),
            download: (id) => apiRoute(`/download/${encodeURIComponent(id)}`),
            upload: apiRoute('/upload'),
        },
        servers: {
            list: apiRoute('/servers'),
            join: apiRoute('/servers/join'),
            byId: (serverId) => apiRoute(`/servers/${encodeURIComponent(serverId)}`),
            channels: (serverId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/channels`),
            channel: (serverId, channelId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}`),
            channelMessages: (serverId, channelId, limit, offset) => apiRoute(`/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}&offset=${offset}`),
            assets: (serverId, kind) => apiRoute(`/servers/${encodeURIComponent(serverId)}/assets/${kind}`),
            members: (serverId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/members`),
            member: (serverId, username) => apiRoute(`/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(username)}`),
            roles: (serverId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/roles`),
            role: (serverId, roleId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/roles/${encodeURIComponent(roleId)}`),
            invites: (serverId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/invites`),
            permissions: (serverId, channelId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/permissions`),
        },
    });

    window.ZaliApiRoutes = API_ROUTES;
})();
