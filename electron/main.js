import { app, BrowserWindow, ipcMain, protocol, session, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installIpc } from './ipc/registry.js';
import { registerAllCommands } from './ipc/commands.js';
import { installMediaProtocol, MEDIA_SCHEME } from './protocol/media-protocol.js';
import { initAppSettings, getWindowState, saveWindowState } from './services/app-settings.js';
import { setLogDirectory, logError, logInfo } from './services/log-service.js';
import { closeLibrary } from './services/library-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

/** Shared main-process state passed to every IPC handler. */
const appContext = {
  library: null,
  mainWindow: null,
  userDataDir: null,
  sendEvent(name, data) {
    if (appContext.mainWindow && !appContext.mainWindow.isDestroyed()) {
      appContext.mainWindow.webContents.send('worldhub:event', name, data);
    }
  },
};

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = appContext.mainWindow;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  ]);

  app.whenReady().then(onReady).catch((err) => {
    logError('main.ready', err);
    app.quit();
  });
}

function onReady() {
  appContext.userDataDir = app.getPath('userData');
  initAppSettings(appContext.userDataDir);
  setLogDirectory(path.join(appContext.userDataDir, 'logs'));

  hardenSession(session.defaultSession);
  installMediaProtocol(appContext);
  registerAllCommands();
  installIpc(appContext);
  openDevLibraryIfRequested().finally(createMainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  logInfo('main', `World Hub ${app.getVersion()} ready.`);
}

/** Development aid: auto-open a library path so the shell can be exercised without dialogs. */
async function openDevLibraryIfRequested() {
  const devPath = process.env.WORLDHUB_DEV_LIBRARY;
  if (!devPath) return;
  try {
    const { openLibrary } = await import('./services/library-service.js');
    let result = await openLibrary(appContext, devPath, {});
    if (result.locked && result.lock.stale) {
      result = await openLibrary(appContext, devPath, { takeOverLock: true });
    }
    if (result.locked) logError('main.dev-library', new Error('dev library is locked'));
  } catch (err) {
    logError('main.dev-library', err);
  }
}

function hardenSession(ses) {
  // The app never needs any permission (camera, notifications, etc).
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  // Runtime network access is forbidden: only local files and the
  // media protocol may load.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    const allowed =
      url.startsWith('file://') ||
      url.startsWith(`${MEDIA_SCHEME}://`) ||
      url.startsWith('devtools://') ||
      url.startsWith('chrome-extension://');
    callback({ cancel: !allowed });
  });
}

function createMainWindow() {
  const state = getWindowState();
  const win = new BrowserWindow({
    width: state.width ?? 1440,
    height: state.height ?? 900,
    x: state.x,
    y: state.y,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#12100f',
    title: 'World Hub',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  appContext.mainWindow = win;
  if (state.maximized) win.maximize();

  win.loadFile(path.join(projectRoot, 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Development aid: visit a list of routes and log renderer console
  // errors to stderr, so the whole shell can be smoke-tested headlessly.
  if (process.env.WORLDHUB_DEV_ROUTES) {
    const routes = process.env.WORLDHUB_DEV_ROUTES.split(',');
    const size = /^(\d+)x(\d+)$/.exec(process.env.WORLDHUB_DEV_SIZE ?? '');
    if (size) win.setSize(Number(size[1]), Number(size[2]));
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 'warning') {
        process.stderr.write(`[renderer:${event.level}] ${event.message}\n`);
      }
    });
    win.webContents.once('did-finish-load', async () => {
      for (const route of routes) {
        await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(route)}; undefined`);
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      process.stderr.write('[dev-routes] done\n');
    });
  }

  if (process.env.WORLDHUB_SMOKE_CREATE_DIRECTORY) {
    win.webContents.once('did-finish-load', async () => {
      try {
        await runChooserSmoke(win);
        process.stdout.write('[chooser-smoke] passed\n');
        app.exit(0);
      } catch (err) {
        process.stderr.write(`[chooser-smoke] FAILED: ${err.stack ?? err}\n`);
        app.exit(1);
      }
    });
  }

  // No window may navigate away from the app or open external windows.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      // External links from Markdown open in the OS browser, never inside the app.
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  const persistBounds = () => {
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized();
    const bounds = win.getNormalBounds();
    saveWindowState({ ...bounds, maximized });
  };
  win.on('resize', persistBounds);
  win.on('move', persistBounds);
  win.on('close', persistBounds);

  // Unsaved editor content is flushed before the window closes: the
  // renderer gets one chance to save, then the close proceeds.
  let flushedBeforeClose = false;
  win.on('close', (event) => {
    if (flushedBeforeClose || win.webContents.isDestroyed()) return;
    event.preventDefault();
    const proceed = () => {
      flushedBeforeClose = true;
      if (!win.isDestroyed()) win.close();
    };
    const timeout = setTimeout(proceed, 3000);
    win.webContents.send('worldhub:event', 'app.flush-before-close', {});
    ipcMainOnceFlushed(() => {
      clearTimeout(timeout);
      proceed();
    });
  });

  win.on('closed', () => {
    if (appContext.mainWindow === win) appContext.mainWindow = null;
  });
}

async function runChooserSmoke(win) {
  await win.webContents.executeJavaScript(`(async () => {
    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('Timed out waiting for ' + label);
    };
    const button = (text) => [...document.querySelectorAll('button')].find((item) => item.textContent.includes(text));
    const visibleMain = () => document.querySelector('#main-inner');
    const assertPage = async (path, heading, control) => {
      location.hash = path;
      const host = await waitFor(() => {
        const candidate = visibleMain();
        return candidate?.querySelector('h1')?.textContent.includes(heading) && candidate;
      }, heading + ' page');
      if (![...host.querySelectorAll('button, a')].some((item) => item.textContent.includes(control))) {
        throw new Error(heading + ' is missing its ' + control + ' control');
      }
    };
    const checkRoutes = async () => {
      await assertPage('/home', 'The archive is empty', 'Create a world');
      await assertPage('/worlds', 'Worlds', 'Create a world');
      await assertPage('/characters', 'Characters', 'Create a character');
      await assertPage('/inbox', 'Inbox', 'Bring a folder');
      await assertPage('/documents', 'Documents', 'Write a new document');
      await assertPage('/assets', 'Assets', 'Import files');
    };

    (await waitFor(() => button('Create a library'), 'chooser create button')).click();
    const form = await waitFor(() => document.querySelector('.overlay form'), 'library name form');
    form.querySelector('input').value = 'Chooser Smoke Library';
    form.requestSubmit();
    await waitFor(visibleMain, 'visible main content');
    await checkRoutes();

    await window.worldhub.invoke('library.close');
    (await waitFor(() => document.querySelector('.recent-btn'), 'recent library button')).click();
    await waitFor(visibleMain, 'reopened visible main content');
    await checkRoutes();
  })()`);
}

/** One-shot listener used by the pre-close flush handshake. */
function ipcMainOnceFlushed(callback) {
  ipcMain.once('worldhub:flushed', () => callback());
}

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  if (appContext.library) {
    event.preventDefault();
    quitting = true;
    Promise.resolve()
      .then(() => closeLibrary(appContext))
      .catch((err) => logError('main.quit', err))
      .finally(() => app.quit());
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

process.on('uncaughtException', (err) => {
  logError('main.uncaught', err);
});
process.on('unhandledRejection', (err) => {
  logError('main.unhandled', err);
});
