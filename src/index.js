/* eslint-disable import/first */

import { app, BrowserWindow, globalShortcut, ipcMain, session, dialog } from 'electron';

import { emptyDirSync, ensureFileSync } from 'fs-extra';
import { join } from 'path';
import windowStateKeeper from 'electron-window-state';
import ms from 'ms';
import { initializeRemote } from './electron-util';
import { enforceMacOSAppLocation } from './enforce-macos-app-location';

initializeRemote();

import { DEFAULT_APP_SETTINGS, DEFAULT_WINDOW_OPTIONS } from './config';

import {
  isMac,
  isWindows,
  isLinux,
  altKey,
} from './environment';
import {
  isDevMode,
  aboutAppDetails,
  userDataRecipesPath,
  userDataPath,
} from './environment-remote';
import { ifUndefinedBoolean } from './jsUtils';

import { mainIpcHandler as basicAuthHandler } from './features/basicAuth';
import ipcApi from './electron/ipc-api';
import Tray from './lib/Tray';
import DBus from './lib/DBus';
import Settings from './electron/Settings';
import handleDeepLink from './electron/deepLinking';
import { isPositionValid } from './electron/windowUtils';
import { appId } from './package.json'; // eslint-disable-line import/no-unresolved
import './electron/exception';

import { asarPath } from './helpers/asar-helpers';
import { openExternalUrl } from './helpers/url-helpers';
import userAgent from './helpers/userAgent-helpers';

const debug = require('debug')('Ferdi:App');

// Globally set useragent to fix user agent override in service workers
debug('Set userAgent to ', userAgent());
app.userAgentFallback = userAgent();

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;
let willQuitApp = false;

// Register methods to be called once the window has been loaded.
let onDidLoadFns = [];

function onDidLoad(fn) {
  if (onDidLoadFns) {
    onDidLoadFns.push(fn);
  } else if (mainWindow) {
    fn(mainWindow);
  }
}

// Ensure that the recipe directory exists
emptyDirSync(userDataRecipesPath('temp'));
ensureFileSync(userDataPath('window-state.json'));

// Set App ID for Windows
if (isWindows) {
  app.setAppUserModelId(appId);
}

// Initialize Settings
const settings = new Settings('app', DEFAULT_APP_SETTINGS);
const proxySettings = new Settings('proxy');

const retrieveSettingValue = (key, defaultValue) =>
  ifUndefinedBoolean(settings.get(key), defaultValue);

if (retrieveSettingValue('sentry', DEFAULT_APP_SETTINGS.sentry)) {
  // eslint-disable-next-line global-require
  require('./sentry');
}

const liftSingleInstanceLock = retrieveSettingValue(
  'liftSingleInstanceLock',
  false,
);

// Force single window
const gotTheLock = liftSingleInstanceLock
  ? true
  : app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();

      if (isWindows) {
        onDidLoad(window => {
          // Keep only command line / deep linked arguments
          const url = argv.slice(1);
          if (url) {
            handleDeepLink(window, url.toString());
          }

          if (argv.includes('--reset-window')) {
            // Needs to be delayed to not interfere with mainWindow.restore();
            setTimeout(() => {
              debug('Resetting windows via Task');
              window.setPosition(
                DEFAULT_WINDOW_OPTIONS.x + 100,
                DEFAULT_WINDOW_OPTIONS.y + 100,
              );
              window.setSize(
                DEFAULT_WINDOW_OPTIONS.width,
                DEFAULT_WINDOW_OPTIONS.height,
              );
            }, 1);
          } else if (argv.includes('--quit')) {
            // Needs to be delayed to not interfere with mainWindow.restore();
            setTimeout(() => {
              debug('Quitting Ferdi via Task');
              app.quit();
            }, 1);
          }
        });
      }
    }
  });
}

// Fix Unity indicator issue
// https://github.com/electron/electron/issues/9046
if (
  isLinux &&
  ['Pantheon', 'Unity:Unity7'].includes(process.env.XDG_CURRENT_DESKTOP)
) {
  process.env.XDG_CURRENT_DESKTOP = 'Unity';
}

// Disable GPU acceleration
if (!retrieveSettingValue('enableGPUAcceleration', false)) {
  debug('Disable GPU Acceleration');
  app.disableHardwareAcceleration();
}

app.setAboutPanelOptions({
  applicationVersion: aboutAppDetails(),
  version: '',
});

const createWindow = () => {
  // Remember window size
  const mainWindowState = windowStateKeeper({
    defaultWidth: DEFAULT_WINDOW_OPTIONS.width,
    defaultHeight: DEFAULT_WINDOW_OPTIONS.height,
    maximize: true, // Automatically maximizes the window, if it was last closed maximized
    fullScreen: true, // Automatically restores the window to full screen, if it was last closed full screen
  });

  let posX = mainWindowState.x || DEFAULT_WINDOW_OPTIONS.x;
  let posY = mainWindowState.y || DEFAULT_WINDOW_OPTIONS.y;

  if (!isPositionValid({ x: posX, y: posY })) {
    debug('Window is out of screen bounds, resetting window');
    posX = DEFAULT_WINDOW_OPTIONS.x;
    posY = DEFAULT_WINDOW_OPTIONS.y;
  }

  // Create the browser window.
  const backgroundColor = retrieveSettingValue('darkMode', false)
    ? '#1E1E1E'
    : settings.get('accentColor');

  mainWindow = new BrowserWindow({
    x: posX,
    y: posY,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: 600,
    minHeight: 500,
    show: false,
    titleBarStyle: isMac ? 'hidden' : 'default',
    frame: isLinux,
    backgroundColor,
    webPreferences: {
      spellcheck: retrieveSettingValue('enableSpellchecking', DEFAULT_APP_SETTINGS.enableSpellchecking),
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
      preload: join(__dirname, 'sentry.js'),
      enableRemoteModule: true,
    },
  });

  app.on('web-contents-created', (e, contents) => {
    if (contents.getType() === 'webview') {
      contents.on('new-window', event => {
        event.preventDefault();
      });
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    const fns = onDidLoadFns;
    onDidLoadFns = null;

    if (!fns) return;

    for (const fn of fns) {
      fn(mainWindow);
    }
  });

  // Initialize System Tray
  const trayIcon = new Tray();

  // Initialize DBus interface
  const dbus = new DBus(trayIcon);

  // Initialize ipcApi
  ipcApi({
    mainWindow,
    settings: {
      app: settings,
      proxy: proxySettings,
    },
    trayIcon,
  });

  // Connect to the DBus after ipcApi took care of the System Tray
  dbus.start();

  // Manage Window State
  mainWindowState.manage(mainWindow);

  // and load the index.html of the app.
  mainWindow.loadURL(`file://${__dirname}/index.html`);

  // Open the DevTools.
  if (isDevMode || process.argv.includes('--devtools')) {
    mainWindow.webContents.openDevTools();
  }

  // Windows deep linking handling on app launch
  if (isWindows) {
    onDidLoad(window => {
      const url = process.argv.slice(1);
      if (url) {
        handleDeepLink(window, url.toString());
      }
    });
  }

  // Emitted when the window is closed.
  mainWindow.on('close', e => {
    debug('Window: close window');
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    if (!willQuitApp && retrieveSettingValue('runInBackground', DEFAULT_APP_SETTINGS.runInBackground)) {
      e.preventDefault();
      if (isWindows) {
        debug('Window: minimize');
        mainWindow.minimize();

        if (retrieveSettingValue('closeToSystemTray', DEFAULT_APP_SETTINGS.closeToSystemTray)) {
          debug('Skip taskbar: true');
          mainWindow.setSkipTaskbar(true);
        }
      } else if (isMac && mainWindow.isFullScreen()) {
        debug('Window: leaveFullScreen and hide');
        mainWindow.once('show', () => mainWindow.setFullScreen(true));
        mainWindow.once('leave-full-screen', () => mainWindow.hide());
        mainWindow.setFullScreen(false);
      } else {
        debug('Window: hide');
        mainWindow.hide();
      }
    } else {
      dbus.stop();
      app.quit();
    }
  });

  // For Windows we need to store a flag to properly restore the window
  // if the window was maximized before minimizing it so system tray
  mainWindow.on('minimize', () => {
    app.wasMaximized = app.isMaximized;

    if (retrieveSettingValue('minimizeToSystemTray', DEFAULT_APP_SETTINGS.minimizeToSystemTray)) {
      debug('Skip taskbar: true');
      mainWindow.setSkipTaskbar(true);
      trayIcon.show();
    }
  });

  mainWindow.on('maximize', () => {
    debug('Window: maximize');
    app.isMaximized = true;
  });

  mainWindow.on('unmaximize', () => {
    debug('Window: unmaximize');
    app.isMaximized = false;
  });

  mainWindow.on('restore', () => {
    debug('Window: restore');
    mainWindow.setSkipTaskbar(false);

    if (app.wasMaximized) {
      debug('Window: was maximized before, maximize window');
      mainWindow.maximize();
    }

    if (!retrieveSettingValue('enableSystemTray', DEFAULT_APP_SETTINGS.enableSystemTray)) {
      debug('Tray: hiding tray icon');
      trayIcon.hide();
    }
  });

  if (isMac) {
    // eslint-disable-next-line global-require
    const { askFormacOSPermissions } = require('./electron/macOSPermissions');
    setTimeout(() => askFormacOSPermissions(mainWindow), ms('30s'));
  }

  mainWindow.on('show', () => {
    debug('Skip taskbar: true');
    mainWindow.setSkipTaskbar(false);
  });

  app.mainWindow = mainWindow;
  app.isMaximized = mainWindow.isMaximized();

  mainWindow.webContents.on('new-window', (e, url) => {
    e.preventDefault();
    openExternalUrl(url);
  });

  if (retrieveSettingValue('startMinimized', DEFAULT_APP_SETTINGS.startMinimized)) {
    mainWindow.hide();
  } else {
    mainWindow.show();
  }

  app.whenReady().then(() => {
    if (retrieveSettingValue('enableGlobalHideShortcut', DEFAULT_APP_SETTINGS.enableGlobalHideShortcut)) {
      // Toggle the window on 'Alt+X'
      globalShortcut.register(`${altKey()}+X`, () => {
        trayIcon.trayMenuTemplate[0].click();
      });
    }
  });
};

// Allow passing command line parameters/switches to electron
// https://electronjs.org/docs/api/chrome-command-line-switches
// used for Kerberos support
// Usage e.g. MACOS
// $ Ferdi.app/Contents/MacOS/Ferdi --auth-server-whitelist *.mydomain.com --auth-negotiate-delegate-whitelist *.mydomain.com
const argv = require('minimist')(process.argv.slice(1));

if (argv['auth-server-whitelist']) {
  app.commandLine.appendSwitch(
    'auth-server-whitelist',
    argv['auth-server-whitelist'],
  );
}
if (argv['auth-negotiate-delegate-whitelist']) {
  app.commandLine.appendSwitch(
    'auth-negotiate-delegate-whitelist',
    argv['auth-negotiate-delegate-whitelist'],
  );
}

// Disable Chromium's poor MPRIS implementation
// and apply workaround for https://github.com/electron/electron/pull/26432
app.commandLine.appendSwitch(
  'disable-features',
  'HardwareMediaKeyHandling,MediaSessionService,CrossOriginOpenerPolicy',
);

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
  // force app to live in /Applications
  enforceMacOSAppLocation();

  // Register App URL
  const protocolClient = isDevMode ? 'ferdi-dev' : 'ferdi';
  if (!app.isDefaultProtocolClient(protocolClient)) {
    app.setAsDefaultProtocolClient(protocolClient);
  }

  if (isWindows) {
    const extraArgs = isDevMode ? `${__dirname} ` : '';
    const iconPath = asarPath(
          join(
            isDevMode ? `${__dirname}../src/` : __dirname,
            'assets/images/taskbar/win32/display.ico',
          ),
        );
    app.setUserTasks([
      {
        program: process.execPath,
        arguments: `${extraArgs}--reset-window`,
        iconPath,
        iconIndex: 0,
        title: 'Move Ferdi to Current Display',
        description: 'Restore the position and size of Ferdi',
      },
      {
        program: process.execPath,
        arguments: `${extraArgs}--quit`,
        iconPath,
        iconIndex: 0,
        title: 'Quit Ferdi',
        description: null,
      },
    ]);
  }

  // eslint-disable-next-line global-require
  require('electron-react-titlebar/main').initialize();

  createWindow();
});

// This is the worst possible implementation as the webview.webContents based callback doesn't work 🖕
// TODO: rewrite to handle multiple login calls
const noop = () => null;
let authCallback = noop;

app.on('login', (event, webContents, request, authInfo, callback) => {
  authCallback = callback;
  debug('browser login event', authInfo);
  event.preventDefault();

  if (!authInfo.isProxy && authInfo.scheme === 'basic') {
    debug('basic auth handler', authInfo);
    basicAuthHandler(mainWindow, authInfo);
  }
});

// TODO: evaluate if we need to store the authCallback for every service
ipcMain.on('feature-basic-auth-credentials', (e, { user, password }) => {
  debug('Received basic auth credentials', user, '********');

  authCallback(user, password);
  authCallback = noop;
});

ipcMain.on('open-browser-window', (e, { url, serviceId }) => {
  const serviceSession = session.fromPartition(`persist:service-${serviceId}`);
  const child = new BrowserWindow({
    parent: mainWindow,
    webPreferences: {
      session: serviceSession,
      // TODO: Aren't these needed here?
      // contextIsolation: false,
      // enableRemoteModule: true,
    },
  });
  child.show();
  child.loadURL(url);
  debug('Received open-browser-window', url);
});

ipcMain.on(
  'modifyRequestHeaders',
  (e, { modifiedRequestHeaders, serviceId }) => {
    debug(
      `Received modifyRequestHeaders ${modifiedRequestHeaders} for serviceId ${serviceId}`,
    );
    for (const headerFilterSet of modifiedRequestHeaders) {
      const { headers, requestFilters } = headerFilterSet;
      session
        .fromPartition(`persist:service-${serviceId}`)
        .webRequest.onBeforeSendHeaders(requestFilters, (details, callback) => {
          for (const key in headers) {
            if (Object.prototype.hasOwnProperty.call(headers, key)) {
              const value = headers[key];
              details.requestHeaders[key] = value;
            }
          }
          callback({ requestHeaders: details.requestHeaders });
        });
    }
  },
);

ipcMain.on('knownCertificateHosts', (e, { knownHosts, serviceId }) => {
  debug(
    `Received knownCertificateHosts ${knownHosts} for serviceId ${serviceId}`,
  );
  session
    .fromPartition(`persist:service-${serviceId}`)
    .setCertificateVerifyProc((request, callback) => {
      // To know more about these callbacks: https://www.electronjs.org/docs/api/session#sessetcertificateverifyprocproc
      const { hostname } = request;
      if (knownHosts.find(item => item.includes(hostname)).length > 0) {
        callback(0);
      } else {
        callback(-2);
      }
    });
});

ipcMain.on('feature-basic-auth-cancel', () => {
  debug('Cancel basic auth');

  authCallback(null);
  authCallback = noop;
});

// Handle synchronous messages from service webviews.

ipcMain.on('find-in-page', (e, text, options) => {
  const { sender: webContents } = e;
  if (webContents !== mainWindow.webContents && typeof text === 'string') {
    const sanitizedOptions = {};
    for (const option of ['forward', 'findNext', 'matchCase']) {
      if (option in options) {
        sanitizedOptions[option] = !!options[option];
      }
    }
    const requestId = webContents.findInPage(text, sanitizedOptions);
    debug('Find in page', text, options, requestId);
    e.returnValue = requestId;
  } else {
    e.returnValue = null;
  }
});

ipcMain.on('stop-find-in-page', (e, action) => {
  const { sender: webContents } = e;
  if (webContents !== mainWindow.webContents) {
    const validActions = [
      'clearSelection',
      'keepSelection',
      'activateSelection',
    ];
    if (validActions.includes(action)) {
      webContents.stopFindInPage(action);
    }
  }
  e.returnValue = null;
});

ipcMain.on('set-spellchecker-locales', (e, { locale, serviceId }) => {
  if (serviceId === undefined) {
    return;
  }

  const serviceSession = session.fromPartition(`persist:service-${serviceId}`);
  const [defaultLocale] = serviceSession.getSpellCheckerLanguages();
  debug(`Spellchecker default locale is: ${defaultLocale}`);

  const locales = [locale, defaultLocale, DEFAULT_APP_SETTINGS.fallbackLocale];
  debug(`Setting spellchecker locales to: ${locales}`);
  serviceSession.setSpellCheckerLanguages(locales);
});

// Quit when all windows are closed.
app.on('window-all-closed', () => {
  // On OS X it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (retrieveSettingValue('runInBackground', DEFAULT_APP_SETTINGS.runInBackground)) {
    debug('Window: all windows closed, quit app');
    app.quit();
  } else {
    debug("Window: don't quit app");
  }
});

app.on('before-quit', event => {
  const yesButtonIndex = 0;
  let selection = yesButtonIndex;
  if (retrieveSettingValue('confirmOnQuit', DEFAULT_APP_SETTINGS.confirmOnQuit)) {
    selection = dialog.showMessageBoxSync(app.mainWindow, {
      type: 'question',
      message: 'Quit',
      detail: 'Do you really want to quit Ferdi?',
      buttons: ['Yes', 'No'],
    });
  }
  if (selection === yesButtonIndex) {
    willQuitApp = true;
  } else {
    event.preventDefault();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

app.on('web-contents-created', (createdEvent, contents) => {
  contents.on('new-window', (event, url, frameNme, disposition) => {
    if (disposition === 'foreground-tab') event.preventDefault();
  });
});

app.on('will-finish-launching', () => {
  // Protocol handler for macOS
  app.on('open-url', (event, url) => {
    event.preventDefault();

    onDidLoad(window => {
      debug('open-url event', url);
      handleDeepLink(window, url);
    });
  });
});
