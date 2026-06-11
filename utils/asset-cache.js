/**
 * Asset Caching and Download Management
 * 
 * Manages cached assets, downloads, and update checks
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const EAAFile = require('./eaa-file');

class AssetCacheManager {
  /**
   * Get the cache directory path
   * @returns {string} Path to cache directory
   */
  static getCacheDirectory() {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const cacheDir = path.join(appData, 'EasyAssets', 'Cache');

    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    return cacheDir;
  }

  /**
   * Get the metadata file path for cached assets list
   * @returns {string} Path to metadata file
   */
  static getMetadataFile() {
    const cacheDir = this.getCacheDirectory();
    return path.join(cacheDir, 'assets.json');
  }

  /**
   * Load all cached assets metadata
   * @returns {Object} Map of asset ID to cached asset info
   */
  static loadCachedAssets() {
    const metadataFile = this.getMetadataFile();

    if (!fs.existsSync(metadataFile)) {
      return {};
    }

    try {
      const data = fs.readFileSync(metadataFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Error loading cached assets metadata:', error);
      return {};
    }
  }

  /**
   * Save cached assets metadata
   * @param {Object} assets - Assets map to save
   */
  static saveCachedAssets(assets) {
    const metadataFile = this.getMetadataFile();
    const cacheDir = path.dirname(metadataFile);

    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    try {
      fs.writeFileSync(metadataFile, JSON.stringify(assets, null, 2), 'utf8');
    } catch (error) {
      console.error('Error saving cached assets metadata:', error);
    }
  }

  /**
   * Get list of all cached assets with their metadata
   * @returns {Promise<Array>} Array of cached asset objects
   */
  static async getCachedAssets() {
    const assets = this.loadCachedAssets();
    const result = [];

    for (const [id, info] of Object.entries(assets)) {
      const eaaPath = path.join(this.getCacheDirectory(), `${id}.eaa`);

      if (fs.existsSync(eaaPath)) {
        try {
          const metadata = await EAAFile.getMetadata(eaaPath);
          result.push({
            id,
            name: metadata.name || info.name,
            version: info.version,
            latestVersion: info.latestVersion,
            cachedAt: info.cachedAt,
            hasUpdate: info.latestVersion && info.latestVersion !== info.version,
            thumbnail: metadata.thumbnail,
            creator: metadata.creator,
          });
        } catch (error) {
          console.error(`Error reading cached asset ${id}:`, error);
        }
      }
    }

    return result;
  }

  /**
   * Cache a downloaded asset
   * @param {string} assetId - Asset ID
   * @param {Buffer} zipBuffer - ZIP file buffer
   * @param {Object} metadata - Asset metadata
   * @returns {Promise<Object>} Cached asset info
   */
  static async cacheAsset(assetId, zipBuffer, metadata) {
    const cacheDir = this.getCacheDirectory();
    const eaaPath = path.join(cacheDir, `${assetId}.eaa`);

    try {
      // Create EAA file
      await EAAFile.create(zipBuffer, metadata, eaaPath);

      // Update metadata
      const assets = this.loadCachedAssets();
      assets[assetId] = {
        name: metadata.name,
        version: metadata.version,
        latestVersion: metadata.version,
        cachedAt: new Date().toISOString(),
        eaaPath,
      };

      this.saveCachedAssets(assets);

      return {
        id: assetId,
        name: metadata.name,
        version: metadata.version,
        cachedAt: assets[assetId].cachedAt,
        hasUpdate: false,
      };
    } catch (error) {
      throw new Error(`Failed to cache asset: ${error.message}`);
    }
  }

  /**
   * Check for asset updates by querying the API
   * @returns {Promise<Array>} List of assets with available updates
   */
  static async checkForUpdates() {
    const assets = this.loadCachedAssets();
    const appUrl = process.env.EASYASSETS_APP_URL || process.env.VITE_WEBSITE_URL || 'http://localhost:3000';

    for (const id in assets) {
      try {
        // Fetch fresh asset metadata and version info from launcher endpoint
        const response = await fetch(`${appUrl}/api/launcher/download-url/${id}`);
        if (!response.ok) {
          console.warn(`Failed to check updates for asset ${id}`);
          continue;
        }
        
        const latest = await response.json();
        const currentVersion = assets[id].version;
        const newVersion = latest.version;

        // Update all metadata with fresh data from API
        assets[id].latestVersion = newVersion;
        assets[id].latestVersionId = latest.versionId;
        assets[id].thumbnail = latest.thumbnail;
        assets[id].creator = latest.creator;
        assets[id].name = latest.name;
        assets[id].description = latest.description;
        
        // Mark if update is available
        if (currentVersion !== newVersion) {
          assets[id].hasUpdate = true;
        }
      } catch (error) {
        console.error(`Error checking updates for asset ${id}:`, error);
      }
    }

    this.saveCachedAssets(assets);
    return this.getCachedAssets();
  }

  /**
   * Get the EAA file path for a cached asset
   * @param {string} assetId - Asset ID
   * @returns {string} Path to EAA file
   */
  static getAssetPath(assetId) {
    const cacheDir = this.getCacheDirectory();
    return path.join(cacheDir, `${assetId}.eaa`);
  }

  /**
   * Delete a cached asset
   * @param {string} assetId - Asset ID
   */
  static deleteCachedAsset(assetId) {
    const eaaPath = this.getAssetPath(assetId);

    if (fs.existsSync(eaaPath)) {
      try {
        fs.unlinkSync(eaaPath);
      } catch (error) {
        console.error(`Error deleting cached asset ${assetId}:`, error);
      }
    }

    // Remove from metadata
    const assets = this.loadCachedAssets();
    delete assets[assetId];
    this.saveCachedAssets(assets);
  }

  /**
   * Download asset from URL
   * @param {string} url - Download URL
   * @param {string} assetId - Asset ID for caching
   * @returns {Promise<Buffer>} Downloaded file buffer
   */
  static async downloadAsset(url, assetId) {
    return new Promise((resolve, reject) => {
      let protocol = https; // Default to https
      
      try {
        const urlObj = new URL(url);
        if (urlObj.protocol === 'http:' || urlObj.hostname === 'localhost' || urlObj.hostname === '127.0.0.1') {
          protocol = http;
        }
      } catch (e) {
        // If URL parsing fails, try http
        protocol = http;
      }
      
      const request = protocol.get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed with status ${response.statusCode}`));
          return;
        }

        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve(Buffer.concat(chunks));
        });
      });

      request.on('error', (error) => {
        // If we get protocol error and we used https, try http
        if (error.message.includes('Protocol "http:" not supported') && protocol === https) {
          const httpRequest = http.get(url, (response) => {
            if (response.statusCode !== 200) {
              reject(new Error(`Download failed with status ${response.statusCode}`));
              return;
            }

            const httpChunks = [];
            response.on('data', (chunk) => httpChunks.push(chunk));
            response.on('end', () => resolve(Buffer.concat(httpChunks)));
          });
          httpRequest.on('error', reject);
        } else {
          reject(error);
        }
      });
    });
  }

  /**
   * Clear old cache entries (optional cleanup)
   * @param {number} daysOld - Delete entries older than this many days
   */
  static clearOldCache(daysOld = 30) {
    const cacheDir = this.getCacheDirectory();
    const cutoffTime = Date.now() - daysOld * 24 * 60 * 60 * 1000;

    try {
      const files = fs.readdirSync(cacheDir);

      for (const file of files) {
        const filePath = path.join(cacheDir, file);
        const stats = fs.statSync(filePath);

        if (stats.mtimeMs < cutoffTime && file.endsWith('.eaa')) {
          fs.unlinkSync(filePath);
          console.log(`Deleted old cached asset: ${file}`);
        }
      }
    } catch (error) {
      console.error('Error clearing old cache:', error);
    }
  }
}

module.exports = AssetCacheManager;
