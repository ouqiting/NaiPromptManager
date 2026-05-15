import { LocalGenItem } from '../types';

const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const GOOGLE_GIS_SCRIPT = 'https://accounts.google.com/gsi/client';
const CLIENT_ID_STORAGE_KEY = 'nai_gdrive_client_id';
const SYNC_CONFIG_STORAGE_KEY = 'nai_gdrive_sync_config';
const DEFAULT_SYNC_FOLDER_NAME = 'novelai';
const HISTORY_FILE_PREFIX = 'nai-history';
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

type TokenClient = {
    callback?: (response: any) => void;
    requestAccessToken: (options?: { prompt?: string }) => void;
};

export interface GoogleDriveSyncConfig {
    clientId: string;
    folderId: string;
    folderName: string;
    folderPath: string;
    enabled: boolean;
}

export interface GoogleDriveFolder {
    id: string;
    name: string;
    parents?: string[];
}

export interface GoogleDriveSyncSummary {
    uploaded: number;
    downloaded: number;
    skipped: number;
    failed: number;
}

export interface GoogleDriveRemoteHistoryMeta {
    version: 1;
    kind: 'nai-history-item';
    id: string;
    createdAt: number;
    prompt: string;
    negativePrompt?: string;
    params: LocalGenItem['params'];
    imageFileId: string;
    imageFileName: string;
    imageMimeType: string;
    remoteBaseName: string;
}

declare global {
    interface Window {
        google?: {
            accounts?: {
                oauth2?: {
                    initTokenClient: (config: Record<string, any>) => TokenClient;
                };
            };
        };
    }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const fileExtFromMime = (mimeType: string) => {
    if (mimeType === 'image/png') return 'png';
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/webp') return 'webp';
    return 'png';
};

const parseDataUri = (dataUri: string) => {
    const matched = dataUri.match(/^data:([^;]+);base64,(.+)$/);
    if (!matched) {
        throw new Error('图片格式无效，无法同步到 Google 云盘');
    }

    const mimeType = matched[1];
    const binary = atob(matched[2]);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return {
        mimeType,
        bytes,
    };
};

const blobToDataUri = async (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error || new Error('读取云盘图片失败'));
        reader.readAsDataURL(blob);
    });
};

const buildHistoryBaseName = (item: Pick<LocalGenItem, 'id' | 'createdAt'>) => {
    return `${HISTORY_FILE_PREFIX}-${item.createdAt}-${item.id}`;
};

const isSameHistoryPayload = (item: LocalGenItem, meta: GoogleDriveRemoteHistoryMeta) => {
    return (
        item.createdAt === meta.createdAt &&
        item.prompt === meta.prompt &&
        (item.negativePrompt || '') === (meta.negativePrompt || '') &&
        JSON.stringify(item.params || {}) === JSON.stringify(meta.params || {})
    );
};

class GoogleDriveSyncService {
    private gisLoader: Promise<void> | null = null;
    private tokenClient: TokenClient | null = null;
    private accessToken: string | null = null;
    private tokenExpiresAt = 0;
    private runtimeClientId: string | null = null;
    private runtimeClientIdPromise: Promise<string> | null = null;

    getClientId() {
        if (this.runtimeClientId) {
            return this.runtimeClientId;
        }

        if (typeof window === 'undefined') return '';
        return localStorage.getItem(CLIENT_ID_STORAGE_KEY) || '';
    }

    saveClientId(clientId: string) {
        if (typeof window === 'undefined') return;
        const trimmed = clientId.trim();
        this.runtimeClientId = trimmed;
        localStorage.setItem(CLIENT_ID_STORAGE_KEY, trimmed);
    }

    async loadClientIdFromServer(force = false) {
        if (!force && this.runtimeClientId !== null) {
            return this.runtimeClientId;
        }

        if (!force && this.runtimeClientIdPromise) {
            return this.runtimeClientIdPromise;
        }

        this.runtimeClientIdPromise = (async () => {
            try {
                const response = await fetch(`/api/public-config?_t=${Date.now()}`, {
                    method: 'GET',
                    cache: 'no-store',
                });
                if (!response.ok) {
                    throw new Error('读取公开配置失败');
                }

                const payload = await response.json() as { googleDriveClientId?: string };
                const serverClientId = (payload.googleDriveClientId || '').trim();
                if (serverClientId) {
                    this.saveClientId(serverClientId);
                    return serverClientId;
                }
            } catch (error) {
                console.warn('读取 Google Drive Client ID 失败:', error);
            } finally {
                this.runtimeClientIdPromise = null;
            }

            const fallback = this.getClientId();
            this.runtimeClientId = fallback || '';
            return this.runtimeClientId;
        })();

        return this.runtimeClientIdPromise;
    }

    getConfig(): GoogleDriveSyncConfig | null {
        if (typeof window === 'undefined') return null;

        const raw = localStorage.getItem(SYNC_CONFIG_STORAGE_KEY);
        if (!raw) return null;

        try {
            return JSON.parse(raw) as GoogleDriveSyncConfig;
        } catch {
            return null;
        }
    }

    saveConfig(config: GoogleDriveSyncConfig) {
        if (typeof window === 'undefined') return;
        localStorage.setItem(SYNC_CONFIG_STORAGE_KEY, JSON.stringify(config));
    }

    isEnabled() {
        const config = this.getConfig();
        return Boolean(config?.enabled && config.folderId && config.clientId);
    }

    private async loadGisScript() {
        if (typeof window === 'undefined') {
            throw new Error('当前环境不支持 Google 授权');
        }

        if (window.google?.accounts?.oauth2) {
            return;
        }

        if (!this.gisLoader) {
            this.gisLoader = new Promise((resolve, reject) => {
                const existing = document.querySelector(`script[src="${GOOGLE_GIS_SCRIPT}"]`) as HTMLScriptElement | null;
                if (existing) {
                    existing.addEventListener('load', () => resolve(), { once: true });
                    existing.addEventListener('error', () => reject(new Error('加载 Google 授权脚本失败')), { once: true });
                    return;
                }

                const script = document.createElement('script');
                script.src = GOOGLE_GIS_SCRIPT;
                script.async = true;
                script.defer = true;
                script.onload = () => resolve();
                script.onerror = () => reject(new Error('加载 Google 授权脚本失败'));
                document.head.appendChild(script);
            });
        }

        await this.gisLoader;
    }

    private async ensureToken(interactive: boolean) {
        const clientId = await this.loadClientIdFromServer();
        if (!clientId) {
            throw new Error('请先在 Cloudflare Pages 变量和机密中配置 GOOGLE_DRIVE_CLIENT_ID');
        }

        await this.loadGisScript();

        if (this.accessToken && Date.now() < this.tokenExpiresAt - 30_000) {
            return this.accessToken;
        }

        if (!window.google?.accounts?.oauth2) {
            throw new Error('Google 授权环境初始化失败');
        }

        if (!this.tokenClient) {
            this.tokenClient = window.google.accounts.oauth2.initTokenClient({
                client_id: clientId,
                scope: GOOGLE_DRIVE_SCOPE,
                callback: () => undefined,
            });
        }

        return new Promise<string>((resolve, reject) => {
            if (!this.tokenClient) {
                reject(new Error('Google 授权初始化失败'));
                return;
            }

            this.tokenClient.callback = (response: any) => {
                if (response?.error) {
                    reject(new Error(response.error_description || response.error));
                    return;
                }

                if (!response?.access_token) {
                    reject(new Error('未获取到 Google 授权令牌'));
                    return;
                }

                this.accessToken = response.access_token;
                const expiresIn = Number(response.expires_in || 3600);
                this.tokenExpiresAt = Date.now() + expiresIn * 1000;
                resolve(response.access_token);
            };

            try {
                this.tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
            } catch (error: any) {
                reject(error);
            }
        });
    }

    private async driveJson<T>(url: string, init: RequestInit = {}, interactive = false): Promise<T> {
        const token = await this.ensureToken(interactive);
        const res = await fetch(url, {
            ...init,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(init.headers || {}),
            },
        });

        if (res.status === 401 && !interactive) {
            this.accessToken = null;
            await sleep(50);
            return this.driveJson<T>(url, init, true);
        }

        if (!res.ok) {
            const text = await res.text();
            throw new Error(text || 'Google Drive 请求失败');
        }

        return res.json() as Promise<T>;
    }

    private async driveRaw(url: string, init: RequestInit = {}, interactive = false) {
        const token = await this.ensureToken(interactive);
        const res = await fetch(url, {
            ...init,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(init.headers || {}),
            },
        });

        if (res.status === 401 && !interactive) {
            this.accessToken = null;
            await sleep(50);
            return this.driveRaw(url, init, true);
        }

        if (!res.ok) {
            const text = await res.text();
            throw new Error(text || 'Google Drive 请求失败');
        }

        return res;
    }

    private async createFolder(name: string, parentId = 'root') {
        return this.driveJson<{ id: string; name: string }>('https://www.googleapis.com/drive/v3/files?fields=id,name', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                name,
                mimeType: FOLDER_MIME_TYPE,
                parents: [parentId],
            }),
        }, true);
    }

    private async findFolderByName(name: string, parentId = 'root') {
        const q = [
            `mimeType = '${FOLDER_MIME_TYPE}'`,
            `name = '${name.replace(/'/g, "\\'")}'`,
            `'${parentId}' in parents`,
            'trashed = false',
        ].join(' and ');

        const encodedQuery = encodeURIComponent(q);
        const response = await this.driveJson<{ files: GoogleDriveFolder[] }>(
            `https://www.googleapis.com/drive/v3/files?q=${encodedQuery}&fields=files(id,name,parents)`
        );
        return response.files[0] || null;
    }

    async getFolderPath(folderId: string): Promise<string> {
        if (folderId === 'root') {
            return '/';
        }

        const segments: string[] = [];
        let cursorId: string | undefined = folderId;

        while (cursorId && cursorId !== 'root') {
            const folder = await this.driveJson<GoogleDriveFolder>(
                `https://www.googleapis.com/drive/v3/files/${cursorId}?fields=id,name,parents`
            );
            segments.unshift(folder.name);
            cursorId = folder.parents?.[0];
        }

        return `/${segments.join('/')}/`;
    }

    async ensureAuthorized() {
        const clientId = await this.loadClientIdFromServer();
        if (!clientId) {
            throw new Error('请先在 Cloudflare Pages 变量和机密中配置 GOOGLE_DRIVE_CLIENT_ID');
        }

        await this.ensureToken(true);
        let config = this.getConfig();

        if (!config?.folderId) {
            const folder = await this.findFolderByName(DEFAULT_SYNC_FOLDER_NAME, 'root') || await this.createFolder(DEFAULT_SYNC_FOLDER_NAME, 'root');
            const folderPath = await this.getFolderPath(folder.id);
            config = {
                clientId,
                folderId: folder.id,
                folderName: folder.name,
                folderPath,
                enabled: true,
            };
            this.saveConfig(config);
        } else if (config.clientId !== clientId) {
            config = {
                ...config,
                clientId,
            };
            this.saveConfig(config);
        }

        return config;
    }

    async listFolders(parentId = 'root') {
        const q = [
            `mimeType = '${FOLDER_MIME_TYPE}'`,
            `'${parentId}' in parents`,
            'trashed = false',
        ].join(' and ');

        const encodedQuery = encodeURIComponent(q);
        const response = await this.driveJson<{ files: GoogleDriveFolder[] }>(
            `https://www.googleapis.com/drive/v3/files?q=${encodedQuery}&orderBy=name_natural&fields=files(id,name,parents)`
        );
        return response.files;
    }

    async selectFolder(folder: GoogleDriveFolder) {
        const clientId = await this.loadClientIdFromServer();
        if (!clientId) {
            throw new Error('请先在 Cloudflare Pages 变量和机密中配置 GOOGLE_DRIVE_CLIENT_ID');
        }

        const folderPath = await this.getFolderPath(folder.id);
        const config: GoogleDriveSyncConfig = {
            clientId,
            folderId: folder.id,
            folderName: folder.name,
            folderPath,
            enabled: true,
        };
        this.saveConfig(config);
        return config;
    }

    private async uploadMultipartFile(
        metadata: Record<string, any>,
        content: Blob | Uint8Array,
        mimeType: string
    ) {
        const boundary = `nai-sync-${crypto.randomUUID()}`;
        const encoder = new TextEncoder();
        const prefix = encoder.encode(
            `--${boundary}\r\n` +
            'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
            `${JSON.stringify(metadata)}\r\n` +
            `--${boundary}\r\n` +
            `Content-Type: ${mimeType}\r\n\r\n`
        );
        const bodyBytes = content instanceof Blob ? new Uint8Array(await content.arrayBuffer()) : content;
        const suffix = encoder.encode(`\r\n--${boundary}--`);
        const payload = new Uint8Array(prefix.length + bodyBytes.length + suffix.length);
        payload.set(prefix, 0);
        payload.set(bodyBytes, prefix.length);
        payload.set(suffix, prefix.length + bodyBytes.length);

        return this.driveJson<{ id: string; name: string }>(
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
            {
                method: 'POST',
                headers: {
                    'Content-Type': `multipart/related; boundary=${boundary}`,
                },
                body: payload,
            }
        );
    }

    private async findRemoteMetaFile(folderId: string, itemId: string) {
        const q = [
            `'${folderId}' in parents`,
            `name contains '${itemId}'`,
            'trashed = false',
        ].join(' and ');

        const encodedQuery = encodeURIComponent(q);
        const response = await this.driveJson<{ files: Array<{ id: string; name: string }> }>(
            `https://www.googleapis.com/drive/v3/files?q=${encodedQuery}&fields=files(id,name)`
        );

        return response.files.find(file => file.name.endsWith('.json')) || null;
    }

    async uploadHistoryItem(item: LocalGenItem, folderId?: string) {
        const config = this.getConfig();
        const targetFolderId = folderId || config?.folderId;

        if (!targetFolderId) {
            throw new Error('尚未选择 Google 云盘同步文件夹');
        }

        const existingMeta = await this.findRemoteMetaFile(targetFolderId, item.id);
        let remoteId = item.id;
        let remoteCreatedAt = item.createdAt;
        let remoteBaseName = buildHistoryBaseName(item);

        if (existingMeta) {
            const existingMetaContent = await this.downloadRemoteMeta(existingMeta.id);
            if (isSameHistoryPayload(item, existingMetaContent)) {
                return {
                    imageFileId: existingMetaContent.imageFileId || item.driveImageFileId || '',
                    metaFileId: existingMeta.id,
                    remoteBaseName: existingMetaContent.remoteBaseName || remoteBaseName,
                    remoteId: existingMetaContent.id,
                    skipped: true,
                };
            }

            remoteId = crypto.randomUUID();
            remoteCreatedAt = Date.now();
            remoteBaseName = `${HISTORY_FILE_PREFIX}-${remoteCreatedAt}-${remoteId}`;
        }

        const { mimeType, bytes } = parseDataUri(item.imageUrl);
        const imageFileName = `${remoteBaseName}.${fileExtFromMime(mimeType)}`;

        const imageFile = await this.uploadMultipartFile(
            {
                name: imageFileName,
                parents: [targetFolderId],
            },
            bytes,
            mimeType
        );

        const meta: GoogleDriveRemoteHistoryMeta = {
            version: 1,
            kind: 'nai-history-item',
            id: remoteId,
            createdAt: remoteCreatedAt,
            prompt: item.prompt,
            negativePrompt: item.negativePrompt,
            params: item.params,
            imageFileId: imageFile.id,
            imageFileName,
            imageMimeType: mimeType,
            remoteBaseName,
        };

        const metaFile = await this.uploadMultipartFile(
            {
                name: `${remoteBaseName}.json`,
                parents: [targetFolderId],
            },
            new TextEncoder().encode(JSON.stringify(meta)),
            'application/json'
        );

        return {
            imageFileId: imageFile.id,
            metaFileId: metaFile.id,
            remoteBaseName,
            remoteId,
            skipped: false,
        };
    }

    async syncLocalItems(items: LocalGenItem[], onUploaded?: (item: LocalGenItem, payload: { imageFileId: string; metaFileId: string; remoteBaseName: string; skipped: boolean; }) => Promise<void>) {
        const summary: GoogleDriveSyncSummary = {
            uploaded: 0,
            downloaded: 0,
            skipped: 0,
            failed: 0,
        };

        const config = await this.ensureAuthorized();

        for (const item of items) {
            try {
                const result = await this.uploadHistoryItem(item, config.folderId);
                if (result.skipped) {
                    summary.skipped += 1;
                } else {
                    summary.uploaded += 1;
                }

                if (onUploaded) {
                    await onUploaded(item, result);
                }
            } catch (error) {
                console.error('上传历史到 Google Drive 失败', error);
                summary.failed += 1;
            }
        }

        return summary;
    }

    async listRemoteHistoryMeta(folderId?: string) {
        const config = this.getConfig();
        const targetFolderId = folderId || config?.folderId;

        if (!targetFolderId) {
            throw new Error('尚未选择 Google 云盘同步文件夹');
        }

        const q = [
            `'${targetFolderId}' in parents`,
            `name contains '${HISTORY_FILE_PREFIX}'`,
            'trashed = false',
        ].join(' and ');

        const encodedQuery = encodeURIComponent(q);
        const response = await this.driveJson<{ files: Array<{ id: string; name: string }> }>(
            `https://www.googleapis.com/drive/v3/files?q=${encodedQuery}&fields=files(id,name)&pageSize=1000`
        );

        return response.files.filter(file => file.name.endsWith('.json'));
    }

    async downloadRemoteMeta(fileId: string) {
        const response = await this.driveRaw(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
        return response.json() as Promise<GoogleDriveRemoteHistoryMeta>;
    }

    async downloadRemoteImage(fileId: string) {
        const response = await this.driveRaw(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
        return blobToDataUri(await response.blob());
    }
}

export const googleDriveSync = new GoogleDriveSyncService();
