/**
 * UEFN Project Detection and Management
 * 
 * Scans for UEFN projects and provides utilities for asset installation
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { dialog } = require('electron');

class UEFNProjectScanner {
  /**
   * Get the default UEFN projects directory
   * @returns {string} Path to Fortnite Projects folder
   */
  static getDefaultProjectsPath() {
    const username = os.userInfo().username;
    return path.join('C:', 'Users', username, 'Documents', 'Fortnite Projects');
  }

  /**
   * Check if a directory contains UEFN projects
   * @param {string} basePath - Base directory to scan
   * @returns {Promise<Array>} Array of detected projects
   */
  static async scanProjects(basePath) {
    const projects = [];

    if (!fs.existsSync(basePath)) {
      return projects;
    }

    try {
      const entries = fs.readdirSync(basePath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const projectPath = path.join(basePath, entry.name);

        // Check for .uefnproject file
        let projectFilePath = path.join(projectPath, `${entry.name}.uefnproject`);
        let contentPath = null;

        if (fs.existsSync(projectFilePath)) {
          // New project structure: projectName/Content
          const newContentPath = path.join(projectPath, 'Content');
          if (fs.existsSync(newContentPath)) {
            contentPath = newContentPath;
          }
        } else {
          // Check old project structure: projectName/plugins/projectName/Content
          const oldContentPath = path.join(projectPath, 'plugins', entry.name, 'Content');
          if (fs.existsSync(oldContentPath)) {
            projectFilePath = path.join(projectPath, 'plugins', entry.name, `${entry.name}.uefnproject`);
            if (fs.existsSync(projectFilePath)) {
              contentPath = oldContentPath;
            }
          }
        }

        if (contentPath) {
          projects.push({
            name: entry.name,
            path: projectPath,
            contentPath: contentPath,
          });
        }
      }
    } catch (error) {
      console.error(`Error scanning projects in ${basePath}:`, error);
    }

    return projects;
  }

  /**
   * Scan for UEFN projects in default location
   * @returns {Promise<Array>} Array of detected projects
   */
  static async scanDefaultProjects() {
    const defaultPath = this.getDefaultProjectsPath();
    return this.scanProjects(defaultPath);
  }

  /**
   * Allow user to select a custom projects folder
   * @param {BrowserWindow} mainWindow - Main Electron window for dialog
   * @returns {Promise<Array>} Array of detected projects in custom path
   */
  static async selectCustomProjectsFolder(mainWindow) {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: 'Select UEFN Projects Folder',
        properties: ['openDirectory'],
        message: 'Select the folder containing your UEFN projects',
      });

      if (canceled || !filePaths.length) {
        return [];
      }

      const selectedPath = filePaths[0];
      return this.scanProjects(selectedPath);
    } catch (error) {
      console.error('Error selecting custom projects folder:', error);
      throw error;
    }
  }

  /**
   * Check if a path is a valid UEFN Content directory
   * @param {string} contentPath - Path to check
   * @returns {boolean}
   */
  static isValidContentPath(contentPath) {
    return fs.existsSync(contentPath) && fs.statSync(contentPath).isDirectory();
  }

  /**
   * Create or get a subdirectory in Content folder
   * @param {string} contentPath - Base Content directory
   * @param {string} folderName - Name of the subdirectory
   * @returns {string} Full path to the directory
   */
  static ensureAssetFolder(contentPath, folderName) {
    const assetFolderPath = path.join(contentPath, folderName);

    if (!fs.existsSync(assetFolderPath)) {
      fs.mkdirSync(assetFolderPath, { recursive: true });
    }

    return assetFolderPath;
  }

  /**
   * Get all subdirectories in Content folder (for adding to existing folder option)
   * @param {string} contentPath - Base Content directory
   * @returns {Promise<Array>} Array of subdirectory names
   */
  static async getExistingAssetFolders(contentPath) {
    if (!fs.existsSync(contentPath)) {
      return [];
    }

    try {
      const entries = fs.readdirSync(contentPath, { withFileTypes: true });
      return entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort();
    } catch (error) {
      console.error('Error reading asset folders:', error);
      return [];
    }
  }

  /**
   * Validate that a folder name is safe for use (no special characters, etc)
   * @param {string} folderName - Name to validate
   * @returns {boolean}
   */
  static isValidFolderName(folderName) {
    // Allow alphanumeric, underscore, and hyphen. No spaces or special chars.
    const regex = /^[a-zA-Z0-9_-]+$/;
    return regex.test(folderName) && folderName.length > 0 && folderName.length <= 255;
  }

  /**
   * Sanitize a folder name to make it valid
   * @param {string} folderName - Name to sanitize
   * @returns {string}
   */
  static sanitizeFolderName(folderName) {
    return folderName
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 255);
  }
}

module.exports = UEFNProjectScanner;
