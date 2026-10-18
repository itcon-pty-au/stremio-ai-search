const crypto = require("crypto");
const logger = require("./logger");

// The key comes from the environment (server.js loads .env first) with NO
// fallback.
const SECRET_KEY = process.env.ENCRYPTION_KEY;

// Log a critical error if the key is missing or too short
if (!SECRET_KEY) {
  logger.error(
    "CRITICAL ERROR: ENCRYPTION_KEY environment variable is missing. Encryption/decryption will fail!"
  );
} else if (SECRET_KEY.length < 32) {
  logger.error(
    "CRITICAL ERROR: ENCRYPTION_KEY environment variable is too short (must be at least 32 characters). Encryption/decryption will fail!"
  );
}

// Encryption function
function encryptConfig(configData) {
  try {
    if (!SECRET_KEY || SECRET_KEY.length < 32) {
      throw new Error(
        "Invalid encryption key - must be at least 32 characters"
      );
    }

    // Generate a random initialization vector
    const iv = crypto.randomBytes(16);

    // Create cipher using AES-256-CBC
    const cipher = crypto.createCipheriv(
      "aes-256-cbc",
      Buffer.from(SECRET_KEY.slice(0, 32)),
      iv
    );

    // Encrypt the data
    let encrypted = cipher.update(configData, "utf8", "base64");
    encrypted += cipher.final("base64");

    // Return IV and encrypted data as a single base64 string
    // Make sure the format is consistent: iv:encrypted
    const result = iv.toString("hex") + ":" + encrypted;

    // URL-safe base64 encoding
    return Buffer.from(result)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  } catch (error) {
    logger.error("Encryption error:", { error: error.message });
    return null;
  }
}

// Decryption function
function decryptConfig(encryptedData) {
  try {
    if (!SECRET_KEY || SECRET_KEY.length < 32) {
      throw new Error(
        "Invalid encryption key - must be at least 32 characters"
      );
    }

    // Check if encryptedData is a string
    if (typeof encryptedData !== "string") {
      logger.error("Invalid encrypted data type:", {
        type: typeof encryptedData,
      });
      return null;
    }

    // Add more detailed logging for debugging
    logger.debug("Attempting to decrypt data", {
      length: encryptedData.length,
    });

    // Restore base64 padding and standard characters
    let base64Data = encryptedData.replace(/-/g, "+").replace(/_/g, "/");

    // Add padding if needed
    while (base64Data.length % 4) {
      base64Data += "=";
    }

    // Decode the base64 string
    let buffer;
    try {
      buffer = Buffer.from(base64Data, "base64").toString("utf8");
    } catch (e) {
      logger.error("Base64 decoding error:", { error: e.message });
      return null;
    }

    // Check if buffer is valid
    if (!buffer || buffer.length === 0) {
      logger.error("Empty buffer after base64 decoding");
      return null;
    }

    // Split the IV and encrypted data
    const parts = buffer.split(":");
    if (parts.length !== 2) {
      logger.error(
        "Invalid encrypted data format (expected format: 'iv:encrypted')",
        {
          parts: parts.length,
          bufferPreview: buffer.substring(0, 20) + "...",
        }
      );
      return null;
    }

    const iv = Buffer.from(parts[0], "hex");
    if (iv.length !== 16) {
      logger.error("Invalid IV length", { length: iv.length, expected: 16 });
      return null;
    }

    const encrypted = parts[1];
    if (!encrypted || encrypted.length === 0) {
      logger.error("Empty encrypted data part");
      return null;
    }

    // Create decipher
    const decipher = crypto.createDecipheriv(
      "aes-256-cbc",
      Buffer.from(SECRET_KEY.slice(0, 32)),
      iv
    );

    // Decrypt the data
    let decrypted = decipher.update(encrypted, "base64", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (error) {
    logger.error("Decryption error:", {
      error: error.message,
      dataPreview: encryptedData
        ? encryptedData.substring(0, 20) + "..."
        : "null",
    });
    return null;
  }
}

// Add this function to validate encrypted data format
function isValidEncryptedFormat(encryptedData) {
  if (typeof encryptedData !== "string" || encryptedData.length < 10) {
    return false;
  }

  try {
    // Restore base64 padding and standard characters
    let base64Data = encryptedData.replace(/-/g, "+").replace(/_/g, "/");

    // Add padding if needed
    while (base64Data.length % 4) {
      base64Data += "=";
    }

    // Decode the base64 string
    const buffer = Buffer.from(base64Data, "base64").toString("utf8");

    // Check if it has the expected format (iv:encrypted)
    return buffer.includes(":");
  } catch (e) {
    return false;
  }
}

module.exports = {
  encryptConfig,
  decryptConfig,
  isValidEncryptedFormat,
};
