/**
 * Asset Download Handler for Launcher
 * 
 * Manages downloading assets, converting them to EAA format, and caching them
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const AdmZip = require('adm-zip');
const EAAFile = require('./eaa-file');
const AssetCacheManager = require('./asset-cache');

class LauncherDownloadManager {
  /**
   * Download an asset from URL and cache it
   * @param {string} assetId - Asset ID
   * @param {Object} assetData - Asset metadata
   * @returns {Promise<Object>} Cached asset info
   */
  static async downloadAndCache(assetId, assetData) {
    try {
      const { downloadUrl, name, version, creator, thumbnail } = assetData;

      if (!downloadUrl) {
        throw new Error('Download URL is required');
      }

      // Download the ZIP file
      const zipBuffer = await this.downloadFile(downloadUrl);

      // Create metadata for EAA
      const metadata = {
        id: assetId,
        name,
        version,
        creator,
        thumbnail,
        downloadedAt: new Date().toISOString(),
        ...assetData,
      };

      // Cache the asset
      const cachedAsset = await AssetCacheManager.cacheAsset(assetId, zipBuffer, metadata);

      return cachedAsset;
    } catch (error) {
      throw new Error(`Failed to download and cache asset: ${error.message}`);
    }
  }

  /**
   * Download a file from URL (HTTP or HTTPS)
   * @param {string} url - File URL
   * @returns {Promise<Buffer>} Downloaded file buffer
   */
  static async downloadFile(url) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let protocol = https;
      
      try {
        const urlObj = new URL(url);
        // Use http only for localhost/127.0.0.1 (development), otherwise https
        if (urlObj.hostname === 'localhost' || urlObj.hostname === '127.0.0.1') {
          protocol = http;
        }
      } catch (e) {
        reject(new Error(`Invalid URL: ${url}`));
        return;
      }
      
      const makeRequest = (proto) => {
        const request = proto.get(url, (response) => {
          if (response.statusCode !== 200) {
            reject(new Error(`Download failed with status ${response.statusCode}`));
            return;
          }

          response.on('data', (chunk) => {
            chunks.push(chunk);
          });

          response.on('end', () => {
            resolve(Buffer.concat(chunks));
          });
        });

        request.on('error', (error) => {
          reject(error);
        });
        
        request.setTimeout(30000, () => {
          request.abort();
          reject(new Error('Download timeout'));
        });
      };

      makeRequest(protocol);
    });
  }

  /**
   * Extract a cached asset to a project
   * @param {string} assetId - Asset ID to extract
   * @param {string} projectPath - Project Content directory path
   * @param {string} folderName - Folder name for the asset
   * @returns {Promise<Object>} Extraction result
   */
  static async extractCachedAsset(assetId, projectPath, folderName) {
    try {
      const eaaPath = AssetCacheManager.getAssetPath(assetId);

      if (!fs.existsSync(eaaPath)) {
        throw new Error('Cached asset not found');
      }

      // Ensure folder is valid
      if (!this.isValidFolderName(folderName)) {
        throw new Error('Invalid folder name');
      }

      // Ensure project path exists
      if (!fs.existsSync(projectPath)) {
        throw new Error('Project path does not exist');
      }

      // Create asset folder
      const assetFolder = path.join(projectPath, folderName);
      if (!fs.existsSync(assetFolder)) {
        fs.mkdirSync(assetFolder, { recursive: true });
      }

      // Extract EAA
      const { metadata } = await EAAFile.extract(eaaPath, assetFolder);

      return {
        success: true,
        assetFolder,
        metadata,
      };
    } catch (error) {
      throw new Error(`Failed to extract cached asset: ${error.message}`);
    }
  }

  /**
   * Validate a folder name
   * @param {string} folderName - Name to validate
   * @returns {boolean}
   */
  static isValidFolderName(folderName) {
    const regex = /^[a-zA-Z0-9_-]+$/;
    return regex.test(folderName) && folderName.length > 0 && folderName.length <= 255;
  }

  /**
   * Check if cached asset exists
   * @param {string} assetId - Asset ID
   * @returns {boolean}
   */
  static cacheExists(assetId) {
    const eaaPath = AssetCacheManager.getAssetPath(assetId);
    return fs.existsSync(eaaPath);
  }
}

module.exports = LauncherDownloadManager;
