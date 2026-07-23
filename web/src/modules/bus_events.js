// @ts-check
(function() {
    'use strict';

    /**
     * @enum {string}
     */
    const ZaliBusEvents = Object.freeze({
        RECEIVE_MESSAGE: 'receive_message',
        SET_USERS: 'set_users',
        SET_CONTACTS: 'set_contacts',
        SET_SESSION: 'set_session',
        LOAD_HISTORY: 'load_history',
        LOAD_SERVER_HISTORY: 'load_server_history',
        REFRESH_AFTER_KEY: 'refresh_after_key',
        SYNC_ACTIVE_CONVERSATION: 'sync_active_conversation',
        SET_LOADING: 'set_loading',
        SET_CONNECTION_STATUS: 'set_connection_status',
        ON_SEND_SUCCESS: 'on_send_success',
        ON_SEND_ERROR: 'on_send_error',
        REACTION_UPDATED: 'reaction_updated',
        AVATAR_UPDATED: 'avatar_updated',
        TENOR_RESOLVED: 'tenor_resolved',
        AUTH_RESPONSE: 'auth_response',
        NATIVE_RESPONSE: 'native_response',
        ADD_LOG_ENTRY: 'add_log_entry',
        VOICE_EVENT: 'voice_event',
        UPDATE_EVENT: 'update_event',
        SCREEN_CAPTURE_FRAME: 'screen_capture_frame',
        SCREEN_CAPTURE_ERROR: 'screen_capture_error',
    });

    window.ZaliBusEvents = ZaliBusEvents;
})();
