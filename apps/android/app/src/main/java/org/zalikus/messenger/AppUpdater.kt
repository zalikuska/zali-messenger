package org.zalikus.messenger

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Автообновление APK — Android-половина протокола `DOWNLOAD_UPDATE_REQUEST` /
 * `INSTALL_UPDATE_REQUEST`, который уже говорят macOS (`UpdateService.swift`) и
 * Windows (`native/updates.rs`). Проверку версии, каналы и подпись релиза
 * (`zali-release-sig:v1` над платформой, версией, SHA-256 и ссылкой) делает общий
 * веб (`web/src/interface/updates.js`); сюда приходят уже проверенные ссылка и сумма.
 *
 * Скачанный файл сверяется не только по SHA-256, но и как APK: тот же пакет, версия
 * новее установленной, тот же ключ подписи. Последнее система проверит и сама, но
 * молча — установщик скажет лишь «Приложение не установлено». Отсюда — понятная
 * ошибка ДО запуска установщика (типичный случай: релиз собран на другой машине
 * своим debug.keystore).
 *
 * Установка — системный установщик через `ACTION_VIEW` + FileProvider. Без
 * разрешения «Установка неизвестных приложений» (`REQUEST_INSTALL_PACKAGES` в
 * манифесте + выбор человека в настройках) он не откроется: тогда открываются
 * эти настройки, а вебу уходит ошибка с объяснением.
 */
internal class AppUpdater(private val context: Context) {

    class UpdateException(message: String) : Exception(message)

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .callTimeout(15, TimeUnit.MINUTES)
        .build()

    /** Проверенный APK между загрузкой и установкой. Только в памяти процесса — как
     * `pendingUpdateArchivePath` на macOS и `PENDING_UPDATE_PATH` на Windows. */
    @Volatile
    private var pendingApk: File? = null

    private val updatesDir: File
        get() = File(context.cacheDir, UPDATES_DIR).apply { mkdirs() }

    init {
        // Файлы прошлого процесса не нужны никому: ссылка на них жила только в памяти,
        // а после установки новой версии это ровно её APK — сотни мегабайт кэша зря.
        updatesDir.listFiles()?.forEach { it.delete() }
    }

    /** Блокирующая загрузка — вызывать не с главного потока и не с потока моста JS. */
    fun download(url: String, expectedSha256: String, onProgress: (Double) -> Unit): File {
        if (!url.startsWith("https://")) throw UpdateException("Некорректный URL обновления")
        val expected = expectedSha256.trim().lowercase()
        if (expected.length != 64) throw UpdateException("Нет контрольной суммы обновления")

        pendingApk = null
        updatesDir.listFiles()?.forEach { it.delete() }
        val file = File(updatesDir, "update-${UUID.randomUUID()}.apk")

        val response = try {
            client.newCall(Request.Builder().url(url).build()).execute()
        } catch (e: Exception) {
            throw UpdateException("Не удалось скачать обновление: ${e.message ?: e.javaClass.simpleName}")
        }
        response.use { res ->
            if (!res.isSuccessful) throw UpdateException("Не удалось скачать обновление (HTTP ${res.code})")
            val body = res.body ?: throw UpdateException("Пустой ответ сервера обновлений")
            val total = body.contentLength()
            if (total > MAX_UPDATE_BYTES) throw UpdateException("Обновление превышает допустимый размер")
            val digest = MessageDigest.getInstance("SHA-256")
            var written = 0L
            var lastReported = -1.0
            try {
                body.byteStream().use { input ->
                    file.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            written += read
                            if (written > MAX_UPDATE_BYTES) throw UpdateException("Обновление превышает допустимый размер")
                            digest.update(buffer, 0, read)
                            output.write(buffer, 0, read)
                            if (total > 0) {
                                val fraction = (written.toDouble() / total).coerceIn(0.0, 1.0)
                                if (fraction - lastReported >= 0.02 || fraction >= 1.0) {
                                    lastReported = fraction
                                    onProgress(fraction)
                                }
                            }
                        }
                    }
                }
            } catch (e: UpdateException) {
                file.delete()
                throw e
            } catch (e: Exception) {
                file.delete()
                throw UpdateException("Загрузка обновления прервалась: ${e.message ?: e.javaClass.simpleName}")
            }
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            if (actual != expected) {
                file.delete()
                throw UpdateException("Контрольная сумма обновления не совпадает")
            }
        }

        try {
            verifyApk(file)
        } catch (e: UpdateException) {
            file.delete()
            throw e
        }
        pendingApk = file
        return file
    }

    private fun verifyApk(file: File) {
        val pm = context.packageManager
        val archive = archiveInfo(pm, file) ?: throw UpdateException("Скачанный файл — не APK")
        if (archive.packageName != context.packageName) {
            throw UpdateException("Скачанный APK — другое приложение (${archive.packageName})")
        }
        val installed = installedInfo(pm)
        if (PackageInfoCompat.getLongVersionCode(archive) <= PackageInfoCompat.getLongVersionCode(installed)) {
            throw UpdateException("Скачанный APK не новее установленного (${archive.versionName})")
        }
        // Пустой набор = система не отдала подписи архива (бывает на части прошивок):
        // тогда решает установщик, он проверяет то же самое.
        val archiveSigners = signerDigests(archive)
        val installedSigners = signerDigests(installed)
        if (archiveSigners.isNotEmpty() && installedSigners.isNotEmpty() && archiveSigners != installedSigners) {
            throw UpdateException(
                "Обновление подписано другим ключом, чем установленное приложение — Android его не примет. " +
                    "Установите APK вручную, предварительно удалив текущую версию."
            )
        }
    }

    @Suppress("DEPRECATION")
    private fun archiveInfo(pm: PackageManager, file: File): PackageInfo? {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            PackageManager.GET_SIGNATURES
        }
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.getPackageArchiveInfo(file.absolutePath, PackageManager.PackageInfoFlags.of(flags.toLong()))
        } else {
            pm.getPackageArchiveInfo(file.absolutePath, flags)
        }
    }

    @Suppress("DEPRECATION")
    private fun installedInfo(pm: PackageManager): PackageInfo {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            PackageManager.GET_SIGNATURES
        }
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(flags.toLong()))
        } else {
            pm.getPackageInfo(context.packageName, flags)
        }
    }

    @Suppress("DEPRECATION")
    private fun signerDigests(info: PackageInfo): Set<String> {
        val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val signing = info.signingInfo ?: return emptySet()
            signing.apkContentsSigners
        } else {
            info.signatures
        } ?: return emptySet()
        val sha = MessageDigest.getInstance("SHA-256")
        return signatures.map { sig -> sha.digest(sig.toByteArray()).joinToString("") { "%02x".format(it) } }.toSet()
    }

    /**
     * Открывает системный установщик. Возвращает `null`, если он запущен, иначе —
     * текст ошибки для веба. Вызывать на главном потоке (startActivity).
     */
    fun install(): String? {
        val apk = pendingApk?.takeIf { it.exists() }
            ?: return "Обновление ещё не скачано — нажмите «Скачать» ещё раз."
        if (!context.packageManager.canRequestPackageInstalls()) {
            try {
                context.startActivity(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (_: Exception) {
            }
            return "Разрешите ZaliMessenger установку приложений (откроются настройки), затем вернитесь и нажмите «Установить» ещё раз."
        }
        val uri = try {
            FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
        } catch (e: Exception) {
            return "Не удалось передать APK установщику: ${e.message}"
        }
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, APK_MIME)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return try {
            context.startActivity(intent)
            null
        } catch (e: Exception) {
            "Не удалось открыть установщик: ${e.message}"
        }
    }

    companion object {
        /** Каталог в `cacheDir`; тот же путь объявлен в `res/xml/file_paths.xml`. */
        private const val UPDATES_DIR = "updates"
        private const val APK_MIME = "application/vnd.android.package-archive"
        /** Тот же потолок, что у Windows (`MAX_UPDATE_BYTES` в native/updates.rs). */
        private const val MAX_UPDATE_BYTES = 300L * 1024 * 1024
    }
}
