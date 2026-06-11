const { app, BrowserWindow, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');

// Load environment variables from .env file
require('dotenv').config({
  path: path.join(__dirname, '.env'),
});

const EAAFile = require('./utils/eaa-file');
const UEFNProjectScanner = require('./utils/uefn-scanner');
const AssetCacheManager = require('./utils/asset-cache');
const LauncherDownloadManager = require('./utils/launcher-download');

let mainWindow = null;
let pendingDeepLink = null;
let appUrl = null;
let isRetryingNetworkChange = false;
let loadAttempts = 0;
const MAX_LOAD_ATTEMPTS = 3;

// Standard browser user-agent to bypass CDN / Cloudflare / WAF blocks
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 EasyAssetsLauncher';

function getSupabaseConfig() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey =
    process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn('Supabase credentials not found in environment variables');
    return null;
  }

  return {
    supabaseUrl: supabaseUrl.replace(/\/+$/, ''),
    supabaseAnonKey,
  };
}

async function getWebsiteUrlFromSupabase() {
  const config = getSupabaseConfig();
  if (!config) {
    console.warn('Supabase config unavailable, skipping Supabase URL fetch');
    return null;
  }

  try {
    console.log('Fetching website URL from Supabase...');
    const restUrl = `${config.supabaseUrl}/rest/v1/website_urls?select=url&active=eq.true&order=created_at.desc&limit=1`;
    console.log('Supabase REST endpoint:', restUrl);

    const response = await fetch(restUrl, {
      headers: {
        accept: 'application/json',
        apikey: config.supabaseAnonKey,
        'User-Agent': USER_AGENT,
      },
    });

    if (!response.ok) {
      console.warn(`Supabase fetch responded ${response.status} — skipping`);
      return null;
    }

    const data = await response.json();
    const url = data?.[0]?.url;
    if (!url) {
      console.warn('No website URL found in Supabase response');
      return null;
    }

    console.log('Fetched website URL from Supabase:', url);
    return url;
  } catch (error) {
    console.warn('Failed to load website URL from Supabase:', error.message || error);
    return null;
  }
}

async function initAppUrl() {
  // 1. Try Supabase (live DB)
  const supabaseUrl = await getWebsiteUrlFromSupabase();
  if (supabaseUrl) {
    appUrl = supabaseUrl.replace(/\/+$/, '');
    console.log('App URL from Supabase:', appUrl);
    return;
  }

  // 2. Fall back to environment variable
  const envUrl = process.env.EASYASSETS_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (envUrl) {
    appUrl = envUrl.replace(/\/+$/, '');
    console.log('App URL from env:', appUrl);
    return;
  }

  // 3. Hard-coded fallback
  appUrl = 'https://easyassets-uefn.vercel.app';
  console.log('App URL using hard-coded fallback:', appUrl);
}

function getAppStartUrl() {
  const base = appUrl || 'https://easyassets-uefn.vercel.app';
  try {
    const parsed = new URL(base);
    if (parsed.pathname === '/' || parsed.pathname === '') {
      parsed.pathname = '/assets';
    }
    return parsed.toString();
  } catch {
    return 'https://easyassets-uefn.vercel.app/assets';
  }
}

function sendHealth(payload) {
  if (mainWindow?.webContents) {
    mainWindow.webContents.send('health', payload);
  }
}

function sendStatus(message) {
  if (mainWindow?.webContents) {
    mainWindow.webContents.send('status', message);
  }
}

function isExternalDocsUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.startsWith('/docs');
  } catch {
    return false;
  }
}

function isEasyAssetsDomain(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    if (
      hostname === 'easyassets.rweb.site' ||
      hostname.endsWith('.easyassets.rweb.site')
    ) {
      return true;
    }

    if (appUrl) {
      const appParsed = new URL(appUrl);
      const appDomain = appParsed.hostname.toLowerCase();
      const baseDomain = appDomain.replace(/^(download\.|www\.|launcher\.)/, '');
      if (hostname === appDomain || hostname.endsWith('.' + baseDomain)) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

function isRootUrl(url) {
  try {
    const parsed = new URL(url);
    if (isEasyAssetsDomain(url)) {
      return parsed.pathname === '/' || parsed.pathname === '';
    }
    return false;
  } catch {
    return false;
  }
}

function loadFallbackPage(reason) {
  console.warn('Loading fallback page. Reason:', reason);
  if (!mainWindow) return;

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  sendStatus('Oops, the website seems down. Showing launcher status.');
  sendHealth({
    status: 'offline',
    message: reason || 'The EasyAssets website is currently unavailable.',
    websiteUrl: getAppStartUrl(),
    services: { database: 'down', auth: 'down', storage: 'down' },
    responseTime: 0,
    timestamp: new Date().toISOString(),
    source: 'launcher',
  });
}

/**
 * Try loading the website. Retries up to MAX_LOAD_ATTEMPTS times with
 * an increasing back-off delay before giving up and showing index.html.
 */
async function tryLoadWebsite(attempt = 1) {
  if (!mainWindow) return;

  const startUrl = getAppStartUrl();
  console.log(`Load attempt ${attempt}/${MAX_LOAD_ATTEMPTS}: ${startUrl}`);
  sendStatus('Checking website availability…');

  try {
    const healthUrl = new URL('/api/health', startUrl).toString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10 s timeout

    let response;
    try {
      response = await fetch(healthUrl, {
        headers: { accept: 'application/json', 'User-Agent': USER_AGENT },
        cache: 'no-store',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    // Any HTTP response (even 4xx/5xx) means the server is reachable
    const serverReachable = response.status > 0;
    if (serverReachable) {
      console.log(`Health check responded ${response.status} — loading website`);
      loadAttempts = 0;
      mainWindow.loadURL(startUrl);
      return;
    }
  } catch (err) {
    console.warn(`Health check attempt ${attempt} failed:`, err.message);
  }

  if (attempt < MAX_LOAD_ATTEMPTS) {
    const delay = attempt * 2000; // 2 s, 4 s back-off
    console.log(`Retrying in ${delay}ms…`);
    sendStatus(`Website unreachable. Retrying in ${delay / 1000}s… (attempt ${attempt}/${MAX_LOAD_ATTEMPTS})`);
    await new Promise((r) => setTimeout(r, delay));
    return tryLoadWebsite(attempt + 1);
  }

  loadFallbackPage(`Website unreachable after ${MAX_LOAD_ATTEMPTS} attempts.`);
}

function createWindow() {
  const iconPath = path.join(__dirname, 'favicon.ico');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    show: false,
    autoHideMenuBar: true,
    menuBarVisible: false,
    icon: fs.existsSync(iconPath)
      ? iconPath
      : path.join(__dirname, 'favicon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });


  // WEB DEVTOOLS: Uncomment the line below to open DevTools for debugging the launcher UI
  // mainWindow.webContents.openDevTools();

  mainWindow.setMenu(null);

  // ── Navigation guards ──────────────────────────────────────────────────────

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalDocsUrl(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    if (isRootUrl(url)) {
      mainWindow.loadURL(getAppStartUrl());
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isExternalDocsUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
      return;
    }
    if (isRootUrl(url)) {
      event.preventDefault();
      mainWindow.loadURL(getAppStartUrl());
    }
  });

  // ── Load failure handler ───────────────────────────────────────────────────

  mainWindow.webContents.on(
    'did-fail-load',
    (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;

      // ERR_NETWORK_CHANGED (-21): retry once after a short pause
      if (errorCode === -21 && !isRetryingNetworkChange) {
        isRetryingNetworkChange = true;
        console.warn('Network changed — retrying in 1.5 s…');
        setTimeout(() => {
          isRetryingNetworkChange = false;
          if (mainWindow) mainWindow.loadURL(validatedURL);
        }, 1500);
        return;
      }

      // ERR_ABORTED (-3): usually caused by a redirect / navigation, not a real error
      if (errorCode === -3) return;

      // For all other real failures, fall back to the offline page
      const message = `Page load failed (${errorCode}): ${errorDescription}`;
      console.error(message, validatedURL);
      loadFallbackPage(message);
    }
  );

  // ── Show window once ready ─────────────────────────────────────────────────

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (pendingDeepLink) {
      handleDeepLink(pendingDeepLink);
      pendingDeepLink = null;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // ── Start loading ──────────────────────────────────────────────────────────
  tryLoadWebsite().catch((err) => {
    console.error('Unexpected error in tryLoadWebsite:', err);
    loadFallbackPage(err.message);
  });
}

// ── Helper utilities ───────────────────────────────────────────────────────

function showLauncherDialog(message, options = {}) {
  const dialogOptions = {
    type: options.type || 'info',
    title: options.title || 'EasyAssets Launcher',
    message,
    buttons: ['OK'],
  };

  if (mainWindow) {
    dialog.showMessageBox(mainWindow, dialogOptions);
  } else {
    dialog.showMessageBox(dialogOptions);
  }

  sendStatus(message);
}

function getFilenameFromContentDisposition(headers) {
  const disposition =
    headers['content-disposition'] || headers['Content-Disposition'];
  if (!disposition) return null;

  const match = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
  if (!match) return null;

  try {
    return decodeURIComponent(match[1].replace(/"/g, ''));
  } catch {
    return match[1].replace(/"/g, '');
  }
}

function safeFilename(downloadUrl, fallbackName) {
  try {
    const parsed = new URL(downloadUrl);
    let base = path.basename(parsed.pathname) || fallbackName;
    base = base.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!base.toLowerCase().endsWith('.zip')) base = `${base}.zip`;
    return base.slice(0, 220);
  } catch {
    const safeFallback = fallbackName.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `${safeFallback}.zip`;
  }
}

function downloadToFile(downloadUrl, targetFolder, fallbackName) {
  return new Promise((resolve, reject) => {
    const client = downloadUrl.startsWith('https://') ? https : http;
    const request = client.get(downloadUrl, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed with status ${response.statusCode}`));
        return;
      }

      let filename =
        getFilenameFromContentDisposition(response.headers) ||
        safeFilename(downloadUrl, fallbackName);
      if (!filename.toLowerCase().endsWith('.zip'))
        filename = `${filename}.zip`;

      const destination = path.join(targetFolder, filename);
      const fileStream = fs.createWriteStream(destination);
      response.pipe(fileStream);
      fileStream.on('finish', () =>
        fileStream.close(() => resolve(destination))
      );
      fileStream.on('error', reject);
    });
    request.on('error', reject);
  });
}

async function downloadAsset(downloadUrl, targetFolder, fallbackName) {
  const directory = path.resolve(targetFolder);
  fs.mkdirSync(directory, { recursive: true });
  sendStatus('Starting download...');
  const destination = await downloadToFile(
    downloadUrl,
    directory,
    fallbackName
  );
  sendStatus(`Download complete: ${destination}`);
  return destination;
}

async function isLauncherLoggedIn() {
  if (!mainWindow?.webContents) return false;

  try {
    const loggedIn = await mainWindow.webContents.executeJavaScript(
      `(async () => {
        try {
          const response = await fetch('/api/launcher/session', { credentials: 'include' });
          if (!response.ok) return false;
          const data = await response.json();
          return data?.loggedIn === true;
        } catch {
          return false;
        }
      })()`,
      true
    );
    return Boolean(loggedIn);
  } catch {
    return false;
  }
}

async function ensureLauncherLoggedIn() {
  const isLoggedIn = await isLauncherLoggedIn();
  if (isLoggedIn) return true;

  showLauncherDialog(
    'You must sign in inside the EasyAssets Launcher before using install or download.',
    { type: 'warning', title: 'Sign in required' }
  );
  return false;
}

async function handleLauncherAction(action, params) {
  if (!params.downloadUrl) {
    showLauncherDialog(
      'No download URL provided. Please sign in to the EasyAssets website and try again.',
      { type: 'error' }
    );
    return;
  }

  if (!(await ensureLauncherLoggedIn())) return;

  try {
    if (action === 'download') {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select folder to save the asset',
        buttonLabel: 'Save Here',
        properties: ['openDirectory', 'createDirectory'],
      });

      if (result.canceled || result.filePaths.length === 0) {
        sendStatus('Download canceled.');
        return;
      }

      const destination = await downloadAsset(
        params.downloadUrl,
        result.filePaths[0],
        `easyassets-${params.assetId}`
      );
      showLauncherDialog(`Download complete. File saved to ${destination}`);
    } else if (action === 'install') {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select folder to install the asset',
        buttonLabel: 'Install Here',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: app.getPath('downloads'),
      });

      if (result.canceled || result.filePaths.length === 0) {
        sendStatus('Install canceled.');
        return;
      }

      const destination = await downloadAsset(
        params.downloadUrl,
        result.filePaths[0],
        `easyassets-${params.assetId}`
      );
      showLauncherDialog(
        `Install download complete. File saved to ${destination}`
      );
    } else {
      showLauncherDialog(`Unknown action: ${action}`, { type: 'error' });
    }
  } catch (err) {
    const errorMessage = err.message || 'An unknown error occurred.';
    const userMessage =
      errorMessage.includes('401') || errorMessage.includes('403')
        ? 'Download failed: you may need to log in before trying again.'
        : `Launcher error: ${errorMessage}`;
    showLauncherDialog(userMessage, { type: 'error' });
  }
}

function handleDeepLink(url) {
  try {
    const parsed = new URL(url);
    const action = parsed.hostname;
    const params = {
      assetId: parsed.searchParams.get('assetId') || '',
      versionId: parsed.searchParams.get('versionId') || '',
      licenseId: parsed.searchParams.get('licenseId') || '',
      downloadUrl: parsed.searchParams.get('downloadUrl') || '',
      redirectUrl: parsed.searchParams.get('redirectUrl') || '',
    };

    if (!mainWindow) {
      pendingDeepLink = url;
      return;
    }

    mainWindow.show();

    if (params.redirectUrl) {
      try {
        const redirectUrl = new URL(params.redirectUrl, appUrl).toString();
        mainWindow.loadURL(redirectUrl);
      } catch {
        // ignore invalid redirect URL
      }
    }

    handleLauncherAction(action, params).catch((err) => {
      console.error(err);
      sendStatus(`Launcher error: ${err.message}`);
    });
  } catch (error) {
    console.error('Invalid deep link:', error);
    sendStatus('Invalid launcher deep link.');
  }
}

// Extract cookies from webContents session to pass them seamlessly to background fetches
async function getCookiesForUrl(targetUrl) {
  try {
    if (!mainWindow) return '';
    const cookiesList = await mainWindow.webContents.session.cookies.get({ url: targetUrl });
    return cookiesList.map(c => `${c.name}=${c.value}`).join('; ');
  } catch (error) {
    console.warn('[Launcher] Failed to retrieve session cookies for fetch background sync:', error);
    return '';
  }
}

// ── IPC Handlers ────────────────────────────────────────────────────────────

function registerIpcHandlers() {
  ipcMain.handle('get-cached-assets', async () => {
    try {
      return await AssetCacheManager.getCachedAssets();
    } catch (error) {
      console.error('Error getting cached assets:', error);
      throw error;
    }
  });

  ipcMain.handle('check-asset-updates', async () => {
    try {
      return await AssetCacheManager.checkForUpdates();
    } catch (error) {
      console.error('Error checking for updates:', error);
      throw error;
    }
  });

  ipcMain.handle('install-asset-update', async (event, assetId, options) => {
    try {
      const eaaPath = AssetCacheManager.getAssetPath(assetId);

      if (!fs.existsSync(eaaPath)) throw new Error('Asset file not found');

      let extractPath;

      if (options) {
        const { projectPath, folderName } = options;
        if (!fs.existsSync(projectPath))
          throw new Error('Project path does not exist');
        extractPath = UEFNProjectScanner.ensureAssetFolder(
          projectPath,
          folderName
        );
      } else {
        const result = await dialog.showOpenDialog(mainWindow, {
          title: 'Select Content Folder to Override',
          properties: ['openDirectory'],
        });
        if (result.canceled || !result.filePaths.length)
          throw new Error('Operation canceled');
        extractPath = result.filePaths[0];
      }

      await EAAFile.extract(eaaPath, extractPath);
      return { success: true, path: extractPath };
    } catch (error) {
      console.error('Error installing update:', error);
      throw error;
    }
  });

  ipcMain.handle('update-asset-cache', async (event, assetId) => {
    try {
      sendStatus(`Updating cache for asset ${assetId}...`);

      const baseApiUrl =
        appUrl ||
        process.env.EASYASSETS_APP_URL ||
        'https://easyassets-uefn.vercel.app';

      const cookieString = await getCookiesForUrl(baseApiUrl);

      const response = await fetch(
        `${baseApiUrl}/api/launcher/download-url/${assetId}`,
        { 
          headers: { 
            'User-Agent': USER_AGENT,
            'Cookie': cookieString
          } 
        }
      );

      if (!response.ok) throw new Error('Failed to fetch asset download info');

      const assetData = await response.json();
      const zipBuffer = await LauncherDownloadManager.downloadFile(
        assetData.downloadUrl
      );

      const metadata = {
        id: assetId,
        name: assetData.name,
        version: assetData.version,
        creator: assetData.creator,
        thumbnail: assetData.thumbnail,
        downloadedAt: new Date().toISOString(),
        ...assetData,
      };

      const cachedAsset = await AssetCacheManager.cacheAsset(
        assetId,
        zipBuffer,
        metadata
      );
      sendStatus(`Asset ${assetData.name} cache updated to v${assetData.version}!`);
      return cachedAsset;
    } catch (error) {
      console.error('Error updating asset cache:', error);
      sendStatus(`Failed to update cache: ${error.message}`);
      throw error;
    }
  });

  ipcMain.handle('download-asset-zip', async (event, assetId, customDownloadUrl) => {
    try {
      sendStatus(`Downloading ${assetId} as ZIP...`);

      const baseApiUrl =
        appUrl ||
        process.env.EASYASSETS_APP_URL ||
        'https://easyassets-uefn.vercel.app';

      let downloadUrl = customDownloadUrl;
      let assetName = `asset-${assetId}`;
      let assetVersion = 'latest';

      if (!downloadUrl) {
        // Safe backend fetch injecting session cookies
        const cookieString = await getCookiesForUrl(baseApiUrl);
        const response = await fetch(
          `${baseApiUrl}/api/launcher/download-url/${assetId}`,
          { 
            headers: { 
              'User-Agent': USER_AGENT,
              'Cookie': cookieString
            } 
          }
        );

        if (!response.ok) throw new Error(`Failed to fetch asset info: HTTP ${response.status}`);

        const assetData = await response.json();
        downloadUrl = assetData.downloadUrl;
        assetName = assetData.name || assetName;
        assetVersion = assetData.version || assetVersion;
      }

      if (!downloadUrl) {
        throw new Error('Download URL could not be resolved.');
      }

      // Ensure downloadUrl is absolute
      if (downloadUrl.startsWith('/')) {
        downloadUrl = new URL(downloadUrl, baseApiUrl).toString();
      }

      console.log('[Launcher] Downloading ZIP from URL:', downloadUrl);
      const zipBuffer = await LauncherDownloadManager.downloadFile(downloadUrl);

      const downloadsPath = path.join(os.homedir(), 'Downloads');
      const fileName = `${assetName}-${assetVersion}.zip`.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(downloadsPath, fileName);

      fs.writeFileSync(filePath, zipBuffer);
      sendStatus(`ZIP downloaded to ${downloadsPath}!`);
      
      // Auto highlight/reveal the downloaded file inside user's File Explorer / Finder
      shell.showItemInFolder(filePath);

      return { success: true, path: filePath };
    } catch (error) {
      console.error('Error downloading ZIP:', error);
      sendStatus(`Failed to download ZIP: ${error.message}`);
      throw error;
    }
  });

  ipcMain.handle('scan-uefn-projects', async () => {
    try {
      return await UEFNProjectScanner.scanDefaultProjects();
    } catch (error) {
      console.error('Error scanning projects:', error);
      throw error;
    }
  });

  ipcMain.handle('select-projects-folder', async () => {
    try {
      return await UEFNProjectScanner.selectCustomProjectsFolder(mainWindow);
    } catch (error) {
      console.error('Error selecting projects folder:', error);
      throw error;
    }
  });

  ipcMain.handle('get-existing-asset-folders', async (event, contentPath) => {
    try {
      if (!contentPath) throw new Error('Content path is required');
      return await UEFNProjectScanner.getExistingAssetFolders(contentPath);
    } catch (error) {
      console.error('Error reading existing asset folders:', error);
      throw error;
    }
  });

  ipcMain.handle('download-asset', async (event, assetId, assetData) => {
    try {
      sendStatus(`Downloading ${assetData.name}...`);
      const cachedAsset = await LauncherDownloadManager.downloadAndCache(
        assetId,
        assetData
      );
      sendStatus(`${assetData.name} downloaded and cached successfully!`);
      return { success: true, asset: cachedAsset };
    } catch (error) {
      console.error('Error downloading asset:', error);
      sendStatus(`Failed to download ${assetData.name}: ${error.message}`);
      throw error;
    }
  });

  ipcMain.handle(
    'extract-asset-to-project',
    async (event, assetPath, projectPath, folderName) => {
      try {
        if (!fs.existsSync(assetPath))
          throw new Error('Asset file not found');
        const extractPath = UEFNProjectScanner.ensureAssetFolder(
          projectPath,
          folderName
        );
        const { metadata } = await EAAFile.extract(assetPath, extractPath);
        return { success: true, path: extractPath, metadata };
      } catch (error) {
        console.error('Error extracting asset:', error);
        throw error;
      }
    }
  );

  // IPC: reload the website (called from renderer if it wants to retry)
  ipcMain.handle('reload-website', async () => {
    loadAttempts = 0;
    await tryLoadWebsite();
  });
}

// ── App lifecycle ────────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    const deepLinkArg = argv.find((arg) => arg.startsWith('easyassets://'));
    if (deepLinkArg) handleDeepLink(deepLinkArg);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.easyassets.launcher');

    if (process.defaultApp) {
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('easyassets', process.execPath, [
          path.resolve(process.argv[1]),
        ]);
      }
    } else {
      app.setAsDefaultProtocolClient('easyassets');
    }

    registerIpcHandlers();
    await initAppUrl();
    createWindow();

    if (process.platform === 'win32') {
      const deepLinkArg = process.argv.find((arg) =>
        arg.startsWith('easyassets://')
      );
      if (deepLinkArg) handleDeepLink(deepLinkArg);
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}