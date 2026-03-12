import crypto from "node:crypto";

export function getFileKeyFromEnv() {
  const hex = process.env.FILE_ENC_KEY_HEX || "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "FILE_ENC_KEY_HEX invalide. Il faut 64 caractères hex (32 bytes). Voir .env.example."
    );
  }
  return Buffer.from(hex, "hex");
}

/**
 * Encrypt buffer with AES-256-GCM.
 * Returns { ciphertext, iv, tag }
 */
export function encryptBuffer(key, plaintextBuf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

/**
 * Decrypt buffer with AES-256-GCM.
 */
export function decryptBuffer(key, ciphertextBuf, ivBuf, tagBuf) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, ivBuf);
  decipher.setAuthTag(tagBuf);
  const plaintext = Buffer.concat([decipher.update(ciphertextBuf), decipher.final()]);
  return plaintext;
}