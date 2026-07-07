//! Serde/sqlx data models shared by all HTTP handlers: request payloads,
//! response DTOs, and database row records. Split out of main.rs so the
//! wire/storage shapes are readable in one place.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::time::Instant;

// ============================================================
// MODELS
// ============================================================

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub(crate) struct Message {
    pub(crate) id: String,
    pub(crate) client_id: Option<String>,
    pub(crate) sender: String,
    pub(crate) receiver: String,
    pub(crate) filename: String,
    pub(crate) timestamp: DateTime<Utc>,
    #[serde(rename = "keyVersion", skip_serializing_if = "Option::is_none")]
    pub(crate) key_version: Option<i64>,
    pub(crate) server_id: Option<String>,
    pub(crate) channel_id: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub(crate) struct ReactionSummary {
    pub(crate) emoji: String,
    pub(crate) count: i64,
}

#[derive(Debug, Serialize, Clone)]
pub(crate) struct MessageResponse {
    pub(crate) id: String,
    #[serde(rename = "clientId", skip_serializing_if = "Option::is_none")]
    pub(crate) client_id: Option<String>,
    pub(crate) sender: String,
    pub(crate) receiver: String,
    pub(crate) filename: String,
    pub(crate) timestamp: DateTime<Utc>,
    #[serde(rename = "keyVersion", skip_serializing_if = "Option::is_none")]
    pub(crate) key_version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) server_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) channel_id: Option<String>,
    pub(crate) reactions: Vec<ReactionSummary>,
    #[serde(rename = "myReaction")]
    pub(crate) my_reaction: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub(crate) struct ServerRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) icon: String,
    pub(crate) color: String,
    pub(crate) join_link: String,
    pub(crate) owner: String,
    pub(crate) is_public: i64,
    pub(crate) created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub(crate) struct ServerInviteRecord {
    pub(crate) code: String,
    pub(crate) server_id: String,
    pub(crate) created_by: String,
    pub(crate) max_uses: i64,
    pub(crate) uses: i64,
    pub(crate) expires_at: Option<DateTime<Utc>>,
    pub(crate) created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[allow(non_snake_case)]
pub(crate) struct ServerInviteResponse {
    pub(crate) code: String,
    pub(crate) serverId: String,
    pub(crate) createdBy: String,
    pub(crate) maxUses: i64,
    pub(crate) uses: i64,
    pub(crate) expiresAt: Option<DateTime<Utc>>,
    pub(crate) createdAt: DateTime<Utc>,
    pub(crate) url: String,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub(crate) struct ChannelPermissionRecord {
    pub(crate) channel_id: String,
    pub(crate) role: String,
    pub(crate) can_view: i64,
    pub(crate) can_send: i64,
    pub(crate) can_manage: i64,
    pub(crate) updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[allow(non_snake_case)]
pub(crate) struct ChannelPermissionResponse {
    pub(crate) role: String,
    pub(crate) canView: bool,
    pub(crate) canSend: bool,
    pub(crate) canManage: bool,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub(crate) struct ServerRoleRecord {
    pub(crate) server_id: String,
    pub(crate) role_id: String,
    pub(crate) name: String,
    pub(crate) color: String,
    pub(crate) can_view: i64,
    pub(crate) can_send: i64,
    pub(crate) can_manage: i64,
    pub(crate) can_manage_channels: i64,
    pub(crate) can_manage_roles: i64,
    pub(crate) can_invite: i64,
    pub(crate) can_attach: i64,
    pub(crate) can_embed: i64,
    pub(crate) can_react: i64,
    pub(crate) can_pin: i64,
    pub(crate) can_mention: i64,
    pub(crate) can_voice: i64,
    pub(crate) can_kick: i64,
    pub(crate) can_ban: i64,
    pub(crate) position: i64,
    pub(crate) created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[allow(non_snake_case)]
pub(crate) struct ServerRoleResponse {
    #[serde(rename = "roleId")]
    pub(crate) role_id: String,
    pub(crate) name: String,
    pub(crate) color: String,
    #[serde(rename = "canView")]
    pub(crate) can_view: bool,
    #[serde(rename = "canSend")]
    pub(crate) can_send: bool,
    #[serde(rename = "canManage")]
    pub(crate) can_manage: bool,
    #[serde(rename = "canManageChannels")]
    pub(crate) can_manage_channels: bool,
    #[serde(rename = "canManageRoles")]
    pub(crate) can_manage_roles: bool,
    #[serde(rename = "canInvite")]
    pub(crate) can_invite: bool,
    #[serde(rename = "canAttach")]
    pub(crate) can_attach: bool,
    #[serde(rename = "canEmbed")]
    pub(crate) can_embed: bool,
    #[serde(rename = "canReact")]
    pub(crate) can_react: bool,
    #[serde(rename = "canPin")]
    pub(crate) can_pin: bool,
    #[serde(rename = "canMention")]
    pub(crate) can_mention: bool,
    #[serde(rename = "canVoice")]
    pub(crate) can_voice: bool,
    #[serde(rename = "canKick")]
    pub(crate) can_kick: bool,
    #[serde(rename = "canBan")]
    pub(crate) can_ban: bool,
    pub(crate) position: i64,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub(crate) struct ChannelRecord {
    pub(crate) id: String,
    pub(crate) server_id: String,
    pub(crate) name: String,
    pub(crate) topic: String,
    pub(crate) kind: String,
    pub(crate) position: i64,
    pub(crate) created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Clone)]
pub(crate) struct ChannelResponse {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) topic: String,
    pub(crate) kind: String,
    pub(crate) position: i64,
}


#[derive(Debug, Serialize)]
pub(crate) struct ServerResponse {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) icon: String,
    pub(crate) color: String,
    #[serde(rename = "joinLink")]
    pub(crate) join_link: String,
    pub(crate) owner: String,
    pub(crate) is_public: bool,
    #[serde(rename = "myRole")]
    pub(crate) my_role: Option<String>,
    #[serde(rename = "memberCount")]
    pub(crate) member_count: i64,
    pub(crate) channels: Vec<ChannelResponse>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ServerListResponse {
    pub(crate) servers: Vec<ServerResponse>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ReactionPayload {
    pub(crate) emoji: String,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub(crate) struct AvatarRecord {
    pub(crate) username: String,
    pub(crate) mime_type: String,
    pub(crate) data: Vec<u8>,
    pub(crate) updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct Claims {
    pub(crate) sub: String,
    pub(crate) iss: String,
    pub(crate) aud: String,
    pub(crate) token_version: i64,
    pub(crate) jti: String,
    pub(crate) exp: usize,
}

#[derive(Deserialize)]
pub(crate) struct AuthPayload {
    pub(crate) username: String,
    pub(crate) password: String,
}

#[derive(Serialize, Clone)]
pub(crate) struct AuthResponse {
    pub(crate) token: String,
    pub(crate) username: String,
    #[serde(rename = "cloudVaultSyncEnabled")]
    pub(crate) cloud_vault_sync_enabled: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct WsTicketResponse {
    pub(crate) ticket: String,
}

#[derive(Debug, Clone)]
pub(crate) struct WsTicketRecord {
    pub(crate) username: String,
    pub(crate) expires_at: Instant,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ContactPayload {
    pub(crate) username: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct ContactListResponse {
    pub(crate) contacts: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ServerPayload {
    pub(crate) name: String,
    pub(crate) description: Option<String>,
    pub(crate) icon: Option<String>,
    pub(crate) color: Option<String>,
    pub(crate) join_link: Option<String>,
    pub(crate) is_public: Option<bool>,
    pub(crate) avatar_data_url: Option<String>,
    pub(crate) banner_data_url: Option<String>,
    pub(crate) roles: Option<Vec<ServerRolePayload>>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CloudVaultSyncPayload {
    #[serde(rename = "cloudVaultSyncEnabled")]
    pub(crate) cloud_vault_sync_enabled: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct MeResponse {
    pub(crate) username: String,
    #[serde(rename = "cloudVaultSyncEnabled")]
    pub(crate) cloud_vault_sync_enabled: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ChannelPayload {
    pub(crate) name: String,
    pub(crate) topic: Option<String>,
    pub(crate) kind: Option<String>,
    pub(crate) can_view: Option<bool>,
    pub(crate) can_send: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ChannelUpdatePayload {
    pub(crate) name: Option<String>,
    pub(crate) topic: Option<String>,
    pub(crate) kind: Option<String>,
    pub(crate) position: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub(crate) struct ServerMemberRecord {
    pub(crate) server_id: String,
    pub(crate) username: String,
    pub(crate) role: String,
    pub(crate) joined_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ServerMemberResponse {
    pub(crate) username: String,
    pub(crate) role: String,
    #[serde(rename = "joinedAt")]
    pub(crate) joined_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ServerSettingsPayload {
    pub(crate) name: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) icon: Option<String>,
    pub(crate) color: Option<String>,
    pub(crate) join_link: Option<String>,
    pub(crate) is_public: Option<bool>,
    pub(crate) avatar_data_url: Option<String>,
    pub(crate) banner_data_url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ServerMemberPayload {
    pub(crate) username: String,
    pub(crate) role: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct InvitePayload {
    pub(crate) max_uses: Option<i64>,
    pub(crate) expires_hours: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct JoinInvitePayload {
    pub(crate) code: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct JoinServerLinkPayload {
    pub(crate) link: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ChannelPermissionsPayload {
    pub(crate) permissions: Vec<ChannelPermissionInput>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ChannelPermissionInput {
    pub(crate) role: String,
    pub(crate) can_view: Option<bool>,
    pub(crate) can_send: Option<bool>,
    pub(crate) can_manage: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ServerRolePayload {
    pub(crate) name: String,
    pub(crate) color: Option<String>,
    pub(crate) can_view: Option<bool>,
    pub(crate) can_send: Option<bool>,
    pub(crate) can_manage: Option<bool>,
    pub(crate) can_manage_channels: Option<bool>,
    pub(crate) can_manage_roles: Option<bool>,
    pub(crate) can_invite: Option<bool>,
    pub(crate) can_attach: Option<bool>,
    pub(crate) can_embed: Option<bool>,
    pub(crate) can_react: Option<bool>,
    pub(crate) can_pin: Option<bool>,
    pub(crate) can_mention: Option<bool>,
    pub(crate) can_voice: Option<bool>,
    pub(crate) can_kick: Option<bool>,
    pub(crate) can_ban: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ServerAssetPayload {
    pub(crate) data_url: String,
}

#[derive(Debug, Deserialize, Default)]
pub(crate) struct MessagePageQuery {
    pub(crate) limit: Option<i64>,
    pub(crate) offset: Option<i64>,
    pub(crate) since: Option<String>,
    pub(crate) newest_first: Option<bool>,
}

#[derive(Debug, Deserialize, Default)]
pub(crate) struct UserSearchQuery {
    pub(crate) q: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct StoredAssetMeta {
    pub(crate) mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, sqlx::FromRow, Clone)]
pub(crate) struct DeviceRecord {
    pub(crate) device_id: String,
    pub(crate) owner: String,
    pub(crate) label: String,
    pub(crate) public_key: String,
    pub(crate) signing_key: String,
    pub(crate) key_package: String,
    pub(crate) group_epoch: i64,
    pub(crate) approved: i64,
    pub(crate) revoked: i64,
    pub(crate) approved_by: Option<String>,
    pub(crate) history_days: i64,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) approved_at: Option<DateTime<Utc>>,
    pub(crate) revoked_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
#[allow(non_snake_case)]
pub(crate) struct DeviceResponse {
    pub(crate) deviceId: String,
    pub(crate) owner: String,
    pub(crate) label: String,
    pub(crate) publicKey: String,
    pub(crate) keyPackage: serde_json::Value,
    pub(crate) groupEpoch: i64,
    pub(crate) approved: bool,
    pub(crate) revoked: bool,
    pub(crate) approvedBy: Option<String>,
    pub(crate) historyDays: i64,
    pub(crate) createdAt: DateTime<Utc>,
    pub(crate) approvedAt: Option<DateTime<Utc>>,
    pub(crate) revokedAt: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
pub(crate) struct RegisterDevicePayload {
    pub(crate) deviceId: String,
    pub(crate) label: Option<String>,
    pub(crate) publicKey: Option<String>,
    pub(crate) signingKey: Option<String>,
    pub(crate) keyPackage: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
pub(crate) struct ApproveDevicePayload {
    pub(crate) deviceId: String,
    pub(crate) approvedByDeviceId: String,
    pub(crate) keyPackage: Option<serde_json::Value>,
    pub(crate) signature: Option<String>,
    pub(crate) historyDays: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
pub(crate) struct VaultEventPayload {
    // Клиент (syncCloudVaultPackage) не шлёт deviceId вовсе — обязательное поле
    // роняло десериализацию с 422, и ни один vault event никогда не сохранялся.
    // Отсутствие/null трактуем как "cloud" (анонимная публикация без привязки
    // к устройству), что уже предусмотрено обработчиком.
    pub(crate) deviceId: Option<String>,
    pub(crate) vaultEpoch: Option<i64>,
    pub(crate) encryptedVaultEvent: String,
    pub(crate) issuedToDeviceId: Option<String>,
    pub(crate) signature: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub(crate) struct VaultEventRecord {
    pub(crate) event_id: String,
    pub(crate) owner: String,
    pub(crate) device_id: String,
    pub(crate) issued_to_device_id: Option<String>,
    pub(crate) vault_epoch: i64,
    pub(crate) encrypted_vault_event: String,
    pub(crate) signature: String,
    pub(crate) created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[allow(non_snake_case)]
pub(crate) struct VaultEventResponse {
    pub(crate) eventId: String,
    pub(crate) owner: String,
    pub(crate) deviceId: String,
    pub(crate) issuedToDeviceId: Option<String>,
    pub(crate) vaultEpoch: i64,
    pub(crate) encryptedVaultEvent: String,
    pub(crate) signature: String,
    pub(crate) createdAt: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
pub(crate) struct KeyEnvelopePayload {
    pub(crate) recipient: String,
    pub(crate) scope: String,
    // Device IDs are no longer required or validated — key transfer is a plain
    // per-account sync by username, not gated on device registration/approval.
    // Kept optional (not removed) so older clients that still send them don't break.
    pub(crate) recipientDeviceId: Option<String>,
    pub(crate) senderDeviceId: Option<String>,
    pub(crate) encryptedKey: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub(crate) struct KeyEnvelopeRecord {
    pub(crate) envelope_id: String,
    pub(crate) owner: String,
    pub(crate) scope_key: String,
    pub(crate) sender: String,
    pub(crate) sender_device_id: String,
    pub(crate) recipient_device_id: String,
    pub(crate) encrypted_key: String,
    pub(crate) created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[allow(non_snake_case)]
pub(crate) struct KeyEnvelopeResponse {
    pub(crate) envelopeId: String,
    pub(crate) owner: String,
    pub(crate) scope: String,
    pub(crate) sender: String,
    pub(crate) senderDeviceId: String,
    pub(crate) recipientDeviceId: String,
    pub(crate) encryptedKey: String,
    pub(crate) createdAt: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
pub(crate) struct HistoryTicketPayload {
    pub(crate) issuedByDeviceId: String,
    pub(crate) issuedToDeviceId: String,
    pub(crate) conversationId: String,
    pub(crate) fromTime: String,
    pub(crate) toTime: String,
    pub(crate) expiresAt: String,
    pub(crate) encryptedExportSecrets: String,
    pub(crate) signature: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub(crate) struct HistoryTicketRecord {
    pub(crate) ticket_id: String,
    pub(crate) owner: String,
    pub(crate) issued_by_device_id: String,
    pub(crate) issued_to_device_id: String,
    pub(crate) conversation_id: String,
    pub(crate) from_time: DateTime<Utc>,
    pub(crate) to_time: DateTime<Utc>,
    pub(crate) expires_at: DateTime<Utc>,
    pub(crate) encrypted_export_secrets: String,
    pub(crate) signature: String,
    pub(crate) revoked: i64,
    pub(crate) created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[allow(non_snake_case)]
pub(crate) struct HistoryTicketResponse {
    pub(crate) ticketId: String,
    pub(crate) owner: String,
    pub(crate) issuedByDeviceId: String,
    pub(crate) issuedToDeviceId: String,
    pub(crate) conversationId: String,
    pub(crate) fromTime: DateTime<Utc>,
    pub(crate) toTime: DateTime<Utc>,
    pub(crate) expiresAt: DateTime<Utc>,
    pub(crate) encryptedExportSecrets: String,
    pub(crate) signature: String,
    pub(crate) revoked: bool,
    pub(crate) createdAt: DateTime<Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub(crate) struct TransparencyLogRecord {
    pub(crate) seq: i64,
    pub(crate) owner: String,
    pub(crate) event_type: String,
    pub(crate) group_epoch: i64,
    pub(crate) actor_device_id: String,
    pub(crate) target_device_id: Option<String>,
    pub(crate) event_json: String,
    pub(crate) signature: String,
    pub(crate) created_at: DateTime<Utc>,
}
