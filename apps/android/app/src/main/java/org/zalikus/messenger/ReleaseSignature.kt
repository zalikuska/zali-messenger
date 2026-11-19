package org.zalikus.messenger

import android.util.Base64
import java.math.BigInteger
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/**
 * Подпись релиза — зеркало `verify_release_signature` в apps/windows/src/native/updates.rs
 * и `UpdateService.verifyReleaseSignature` на macOS (формат `release_signature_message`
 * в server/src/updates.rs, ES256 официальным ключом, подпись — сырые r‖s по 32 байта).
 *
 * Раньше Android сверял подпись только в JS, а мост принимал от страницы любой
 * адрес и SHA-256: любой скрипт в WebView мог скачать и предложить к установке
 * произвольный APK (аудит 2026-11-19).
 */
object ReleaseSignature {
    /** Несжатая точка P-256 — та же, что `OFFICIAL_RELEASE_PUBLIC_KEY_B64` у Windows. */
    private const val OFFICIAL_PUBLIC_KEY_B64 =
        "BDUcWsKrt/KoOeUnExrEScgAqUD3JEPCDLS5OqWmER0pm+FXwhzClXxkEh0KG4WdLkm9czOJXgXSuMuYlOcrMWw="

    /** Заголовок SubjectPublicKeyInfo для ecPublicKey + prime256v1 перед 65 байтами точки. */
    private const val P256_SPKI_PREFIX_HEX = "3059301306072a8648ce3d020106082a8648ce3d030107034200"

    fun verify(version: String, sha256: String, url: String, signatureB64: String): Boolean {
        return try {
            val message = "zali-release-sig:v1\nandroid\n$version\n${sha256.trim().lowercase()}\n$url"
            val raw = Base64.decode(signatureB64.trim(), Base64.DEFAULT)
            if (raw.size != 64) return false
            val point = Base64.decode(OFFICIAL_PUBLIC_KEY_B64, Base64.DEFAULT)
            val spki = hexToBytes(P256_SPKI_PREFIX_HEX) + point
            val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spki))
            val verifier = Signature.getInstance("SHA256withECDSA")
            verifier.initVerify(key)
            verifier.update(message.toByteArray(Charsets.UTF_8))
            verifier.verify(rawToDer(raw))
        } catch (e: Exception) {
            false
        }
    }

    /** r‖s (по 32 байта) → DER SEQUENCE { INTEGER r, INTEGER s }, как ждёт JCA. */
    private fun rawToDer(raw: ByteArray): ByteArray {
        fun integer(part: ByteArray): ByteArray {
            val bytes = BigInteger(1, part).toByteArray() // со знаковым нулём, если нужен
            return byteArrayOf(0x02, bytes.size.toByte()) + bytes
        }
        val body = integer(raw.copyOfRange(0, 32)) + integer(raw.copyOfRange(32, 64))
        return byteArrayOf(0x30, body.size.toByte()) + body
    }

    private fun hexToBytes(hex: String): ByteArray =
        ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
}
