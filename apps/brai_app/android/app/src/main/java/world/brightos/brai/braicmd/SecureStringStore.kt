package world.brightos.brai.braicmd

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class SecureStringStore(
    context: Context,
    private val injectedLocalSecretKey: SecretKey? = null,
    private val injectedAccountSecretKey: SecretKey? = injectedLocalSecretKey
) {
    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun read(key: String): String = readEncrypted(key, account = false)

    private fun readEncrypted(key: String, account: Boolean): String {
        val packed = prefs.getString(key, "").orEmpty()
        if (packed.isBlank()) return ""
        val parts = packed.split(":")
        if (parts.size != 2) return ""
        return runCatching {
            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val encrypted = Base64.decode(parts[1], Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, secretKey(account), GCMParameterSpec(128, iv))
            String(cipher.doFinal(encrypted), Charsets.UTF_8)
        }.getOrDefault("")
    }

    fun write(key: String, value: String) {
        val clean = value.trim()
        if (clean.isBlank()) {
            clear(key)
            return
        }
        prefs.edit().putString(key, encrypt(clean, account = false)).apply()
    }

    fun has(key: String): Boolean = read(key).isNotBlank()

    fun clear(key: String) {
        prefs.edit().remove(key).apply()
    }

    fun deviceAccessToken(): String = read(KEY_DEVICE_ACCESS_TOKEN)

    fun writeDeviceAccessToken(value: String) {
        val clean = value.trim()
        val editor = prefs.edit()
        if (clean.isBlank()) editor.remove(KEY_DEVICE_ACCESS_TOKEN)
        else editor.putString(KEY_DEVICE_ACCESS_TOKEN, encrypt(clean, account = false))
        check(editor.commit()) { "access_store_failed" }
    }

    fun stagePendingAccountRevocation(token: String, nowEpochMs: Long = System.currentTimeMillis()) {
        val clean = token.trim()
        if (clean.isBlank()) return
        require(clean.length <= 4_096 && !clean.contains('\r') && !clean.contains('\n')) {
            "invalid_access_token"
        }
        val pending = pendingAccountRevocations(nowEpochMs)
        if (pending.any { it.token == clean }) return
        writePendingAccountRevocations(
            pending + PendingAccountRevocation(nowEpochMs + PENDING_REVOCATION_TTL_MS, clean)
        )
    }

    fun pendingAccountRevocationToken(nowEpochMs: Long = System.currentTimeMillis()): String {
        return pendingAccountRevocations(nowEpochMs).firstOrNull()?.token.orEmpty()
    }

    fun acknowledgePendingAccountRevocation(token: String, nowEpochMs: Long = System.currentTimeMillis()) {
        val clean = token.trim()
        if (clean.isBlank()) return
        writePendingAccountRevocations(
            pendingAccountRevocations(nowEpochMs).filterNot { it.token == clean }
        )
    }

    fun clearPendingAccountRevocation() {
        writePendingAccountRevocations(emptyList())
    }

    private fun pendingAccountRevocations(nowEpochMs: Long): List<PendingAccountRevocation> {
        val payload = readEncrypted(KEY_PENDING_ACCOUNT_REVOCATION, account = true)
        if (payload.isBlank()) return emptyList()
        val parsed = payload.split('\n').chunked(2).mapNotNull { fields ->
            if (fields.size != 2) return@mapNotNull null
            val expiresAt = fields[0].toLongOrNull() ?: return@mapNotNull null
            val pendingToken = fields[1].trim()
            if (expiresAt <= nowEpochMs || pendingToken.isBlank() || pendingToken.length > 4_096 ||
                pendingToken.contains('\r') || pendingToken.contains('\n')) null
            else PendingAccountRevocation(expiresAt, pendingToken)
        }.distinctBy { it.token }
        if (serializePendingAccountRevocations(parsed) != payload) {
            writePendingAccountRevocations(parsed)
        }
        return parsed
    }

    private fun writePendingAccountRevocations(values: List<PendingAccountRevocation>) {
        val payload = serializePendingAccountRevocations(values)
        val editor = prefs.edit()
        if (payload.isBlank()) editor.remove(KEY_PENDING_ACCOUNT_REVOCATION)
        else editor.putString(KEY_PENDING_ACCOUNT_REVOCATION, encrypt(payload, account = true))
        check(editor.commit()) { "pending_revocation_store_failed" }
    }

    private fun serializePendingAccountRevocations(values: List<PendingAccountRevocation>): String =
        values.joinToString("\n") { "${it.expiresAtEpochMs}\n${it.token}" }

    fun providerKey(providerId: String): String {
        val userId = ConfigStore(appContext).accountUserId
        return if (userId.isBlank()) localProviderKey(providerId)
        else if (providerId in ConfigStore.ACCOUNT_PROVIDER_IDS) accountProviderKey(userId, providerId)
        else ""
    }

    fun localProviderKey(providerId: String): String = read(providerStorageKey(providerId))

    fun accountProviderKey(userId: String, providerId: String): String =
        readEncrypted(accountProviderStorageKey(userId, providerId), account = true)

    fun migrateLegacyProviderKey(providerId: String) {
        if (localProviderKey(providerId).isNotBlank()) return
        val legacy = read(KEY_LLM_API_KEY)
        if (legacy.isBlank()) return
        write(providerStorageKey(providerId), legacy)
        clear(KEY_LLM_API_KEY)
    }

    fun writeProviderKey(providerId: String, value: String) = write(providerStorageKey(providerId), value)

    fun hasProviderKey(providerId: String): Boolean = providerKey(providerId).isNotBlank()

    fun clearProviderKey(providerId: String) = clear(providerStorageKey(providerId))

    fun localProviderCandidates(userId: String): Map<String, LocalProviderCredentialCandidate> = ConfigStore.ACCOUNT_PROVIDER_IDS
        .sorted()
        .mapNotNull { providerId ->
            val apiKey = localProviderKey(providerId)
            if (apiKey.isBlank()) return@mapNotNull null
            val version = MessageDigest.getInstance("SHA-256")
                .digest("$providerId\u0000$apiKey".toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
            if (readEncrypted(accountImportVersionKey(userId, providerId), account = true) == version) return@mapNotNull null
            providerId to LocalProviderCredentialCandidate(apiKey, version)
        }
        .toMap()

    fun writeAccountProviderKey(userId: String, providerId: String, value: String) =
        prefs.edit().putString(accountProviderStorageKey(userId, providerId), encrypt(value.trim(), account = true)).apply()

    fun replaceAccountProviderKeys(
        userId: String,
        values: Map<String, String>,
        acknowledgedLocalVersions: Map<String, String> = emptyMap()
    ) {
        val packed = values.mapNotNull { (providerId, value) ->
            if (providerId !in ConfigStore.ACCOUNT_PROVIDER_IDS || value.isBlank()) null
            else accountProviderStorageKey(userId, providerId) to encrypt(value.trim(), account = true)
        }.toMap()
        val editor = prefs.edit()
        ConfigStore.ACCOUNT_PROVIDER_IDS.forEach { editor.remove(accountProviderStorageKey(userId, it)) }
        packed.forEach(editor::putString)
        acknowledgedLocalVersions.forEach { (providerId, version) ->
            if (providerId in ConfigStore.ACCOUNT_PROVIDER_IDS && version.isNotBlank()) {
                editor.putString(accountImportVersionKey(userId, providerId), encrypt(version, account = true))
            }
        }
        check(editor.commit()) { "account_provider_store_failed" }
    }

    fun acknowledgeLocalProviderVersions(userId: String, versions: Map<String, String>) {
        if (versions.isEmpty()) return
        val editor = prefs.edit()
        versions.forEach { (providerId, version) ->
            if (providerId in ConfigStore.ACCOUNT_PROVIDER_IDS && version.isNotBlank()) {
                editor.putString(accountImportVersionKey(userId, providerId), encrypt(version, account = true))
            }
        }
        check(editor.commit()) { "account_provider_store_failed" }
    }

    fun clearAccountProviderKeys(userId: String) {
        if (userId.isBlank()) return
        val editor = prefs.edit()
        ConfigStore.ACCOUNT_PROVIDER_IDS.forEach { editor.remove(accountProviderStorageKey(userId, it)) }
        check(editor.commit()) { "account_provider_store_failed" }
    }

    private fun providerStorageKey(providerId: String): String =
        "provider_${providerId.lowercase().replace(Regex("[^a-z0-9-]"), "")}_api_key"

    private fun accountProviderStorageKey(userId: String, providerId: String): String {
        require(userId.isNotBlank()) { "account_user_required" }
        require(providerId in ConfigStore.ACCOUNT_PROVIDER_IDS) { "unsupported_provider" }
        return "account_${userHash(userId)}_provider_${providerId.lowercase()}_api_key"
    }

    private fun accountImportVersionKey(userId: String, providerId: String): String {
        require(userId.isNotBlank()) { "account_user_required" }
        require(providerId in ConfigStore.ACCOUNT_PROVIDER_IDS) { "unsupported_provider" }
        return "account_${userHash(userId)}_provider_${providerId.lowercase()}_imported_local_version"
    }

    private fun userHash(userId: String): String = MessageDigest.getInstance("SHA-256")
        .digest(userId.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }

    private fun encrypt(value: String, account: Boolean): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey(account))
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) +
            ":" +
            Base64.encodeToString(encrypted, Base64.NO_WRAP)
    }

    private fun secretKey(account: Boolean): SecretKey {
        (if (account) injectedAccountSecretKey else injectedLocalSecretKey)?.let { return it }
        val alias = if (account) ACCOUNT_KEY_ALIAS else LOCAL_KEY_ALIAS
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setUnlockedDeviceRequired(false)
            }
            .build()
        generator.init(spec)
        return generator.generateKey()
    }

    companion object {
        const val KEY_LLM_API_KEY = "llm_api_key"
        private const val KEY_DEVICE_ACCESS_TOKEN = "device_access_token"
        private const val KEY_PENDING_ACCOUNT_REVOCATION = "pending_account_access_revocation"
        private const val PREFS = "brai_cmd_secure"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val LOCAL_KEY_ALIAS = "brai_cmd_llm_provider"
        private const val ACCOUNT_KEY_ALIAS = "brai_cmd_account_providers"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        internal const val PENDING_REVOCATION_TTL_MS = 30L * 24L * 60L * 60L * 1_000L
    }

    private data class PendingAccountRevocation(
        val expiresAtEpochMs: Long,
        val token: String
    )
}

internal data class LocalProviderCredentialCandidate(val apiKey: String, val version: String)
