/**
 * EAA File Format Handler
 * 
 * EAA (EasyAssets Archive) is a custom container format that wraps ZIP files.
 * Format: [Magic Header (4 bytes)] [Version (1 byte)] [Metadata JSON length (4 bytes)] [Metadata JSON] [ZIP data]
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const MAGIC_HEADER = Buffer.from([0xEA, 0xAA, 0x00, 0x01]); // EAA magic bytes
const VERSION = 1;
const METADATA_LENGTH_SIZE = 4;

class EAAFile {
  /**
   * Create an EAA file from a ZIP buffer
   * @param {Buffer} zipBuffer - The ZIP file buffer
   * @param {Object} metadata - Asset metadata
   * @param {string} outputPath - Where to save the EAA file
   */
  static async create(zipBuffer, metadata, outputPath) {
    try {
      const metadataJson = JSON.stringify(metadata);
      const metadataBuffer = Buffer.from(metadataJson, 'utf8');
      const metadataLengthBuffer = Buffer.alloc(METADATA_LENGTH_SIZE);
      metadataLengthBuffer.writeUInt32BE(metadataBuffer.length, 0);

      // Combine all parts
      const eaaBuffer = Buffer.concat([
        MAGIC_HEADER,
        Buffer.from([VERSION]),
        metadataLengthBuffer,
        metadataBuffer,
        zipBuffer,
      ]);

      // Ensure directory exists
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(outputPath, eaaBuffer);
      return { success: true, path: outputPath };
    } catch (error) {
      throw new Error(`Failed to create EAA file: ${error.message}`);
    }
  }

  /**
   * Parse an EAA file and extract metadata and ZIP
   * @param {string} eaaPath - Path to the EAA file
   * @returns {Object} {metadata, zipBuffer}
   */
  static async parse(eaaPath) {
    try {
      const buffer = fs.readFileSync(eaaPath);

      // Validate magic header
      if (!buffer.slice(0, 4).equals(MAGIC_HEADER)) {
        throw new Error('Invalid EAA file format: magic header mismatch');
      }

      // Check version
      const version = buffer[4];
      if (version !== VERSION) {
        throw new Error(`Unsupported EAA version: ${version}`);
      }

      // Read metadata length
      const metadataLength = buffer.readUInt32BE(5);
      const metadataStart = 5 + METADATA_LENGTH_SIZE;
      const metadataEnd = metadataStart + metadataLength;

      // Extract metadata
      const metadataBuffer = buffer.slice(metadataStart, metadataEnd);
      const metadata = JSON.parse(metadataBuffer.toString('utf8'));

      // Extract ZIP buffer
      const zipBuffer = buffer.slice(metadataEnd);

      return { metadata, zipBuffer };
    } catch (error) {
      throw new Error(`Failed to parse EAA file: ${error.message}`);
    }
  }

  /**
   * Extract EAA file to a directory
   * @param {string} eaaPath - Path to the EAA file
   * @param {string} extractPath - Where to extract the contents
   * @returns {Object} {metadata, extractedPath}
   */
  static async extract(eaaPath, extractPath) {
    try {
      const { metadata, zipBuffer } = await this.parse(eaaPath);

      // Ensure extract directory exists
      if (!fs.existsSync(extractPath)) {
        fs.mkdirSync(extractPath, { recursive: true });
      }

      // Extract ZIP contents safely, rejecting unsafe paths
      const zip = new AdmZip(zipBuffer);
      await EAAFile.extractZipSafely(zip, extractPath);

      return { success: true, metadata, extractedPath: extractPath };
    } catch (error) {
      throw new Error(`Failed to extract EAA file: ${error.message}`);
    }
  }

  /**
   * Get metadata from an EAA file without extracting
   * @param {string} eaaPath - Path to the EAA file
   * @returns {Object} metadata
   */
  static async getMetadata(eaaPath) {
    try {
      const { metadata } = await this.parse(eaaPath);
      return metadata;
    } catch (error) {
      throw new Error(`Failed to read EAA metadata: ${error.message}`);
    }
  }

  static async extractZipSafely(zip, extractPath) {
    const entries = zip.getEntries();

    for (const entry of entries) {
      const entryName = EAAFile.normalizeEntryName(entry.entryName);
      if (!entryName) continue;

      const destinationPath = path.join(extractPath, entryName);
      const relativeTarget = path.relative(extractPath, destinationPath);
      if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
        throw new Error(`Unsafe ZIP entry path detected: ${entry.entryName}`);
      }

      if (entry.isDirectory) {
        fs.mkdirSync(destinationPath, { recursive: true });
        continue;
      }

      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.writeFileSync(destinationPath, entry.getData());
    }
  }

  static normalizeEntryName(entryName) {
    const normalized = entryName.replace(/\\/g, '/').replace(/^\/+/, '');
    const safeName = path.posix.normalize(normalized);

    if (!safeName || safeName === '.' || safeName.startsWith('..')) {
      throw new Error(`Invalid ZIP entry name: ${entryName}`);
    }

    const segments = safeName.split('/');
    if (segments.includes('..')) {
      throw new Error(`Invalid ZIP entry name: ${entryName}`);
    }

    return safeName;
  }
}

module.exports = EAAFile;
