package world.brightos.brai.braicmd

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class SecureStringStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun read(key: String): String {
        val packed = prefs.getString(key, "").orEmpty()
        if (packed.isBlank()) return ""
        val parts = packed.split(":")
        if (parts.size != 2) return ""
        return runCatching {
            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val encrypted = Base64.decode(parts[1], Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(encrypted), Charsets.UTF_8)
        }.getOrDefault("")
    }

    fun write(key: String, value: String) {
        val clean = value.trim()
        if (clean.isBlank()) {
            clear(key)
            return
        }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val encrypted = cipher.doFinal(clean.toByteArray(Charsets.UTF_8))
        val packed = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) +
            ":" +
            Base64.encodeToString(encrypted, Base64.NO_WRAP)
        prefs.edit().putString(key, packed).apply()
    }

    fun has(key: String): Boolean = read(key).isNotBlank()

    fun clear(key: String) {
        prefs.edit().remove(key).apply()
    }

    fun providerKey(providerId: String): String {
        return read(providerStorageKey(providerId))
    }

    fun migrateLegacyProviderKey(providerId: String) {
        if (providerKey(providerId).isNotBlank()) return
        val legacy = read(KEY_LLM_API_KEY)
        if (legacy.isBlank()) return
        write(providerStorageKey(providerId), legacy)
        clear(KEY_LLM_API_KEY)
    }

    fun writeProviderKey(providerId: String, value: String) = write(providerStorageKey(providerId), value)

    fun hasProviderKey(providerId: String): Boolean = providerKey(providerId).isNotBlank()

    fun clearProviderKey(providerId: String) = clear(providerStorageKey(providerId))

    private fun providerStorageKey(providerId: String): String =
        "provider_${providerId.lowercase().replace(Regex("[^a-z0-9-]"), "")}_api_key"

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
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
        private const val PREFS = "brai_cmd_secure"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "brai_cmd_llm_provider"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
