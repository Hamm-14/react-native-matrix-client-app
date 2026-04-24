import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ClientBuilder,
  ClientError,
  EventTimelineItem,
  FileInfo,
  initPlatform,
  LogLevel,
  MediaSource,
  Membership,
  MessageType,
  ReceiptType,
  RoomInfo,
  Session,
  SlidingSyncVersion,
  SlidingSyncVersionBuilder,
  TextMessageContent,
  TimelineDiff,
  TimelineItemLike,
  TraceLogPacks,
  TracingConfiguration,
  uniffiInitAsync,
  UploadParameters,
  UploadSource,
  ImageInfo,
} from '@unomed/react-native-matrix-sdk';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  startTransition,
} from 'react';
import DocumentPicker from 'react-native-document-picker';
import RNFS from 'react-native-fs';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

const SESSION_KEY = 'matrix-rust-rn-poc.session';
const DEFAULT_HOMESERVER = 'https://matrix.sistan.app';
const DEFAULT_DEVICE_NAME = 'Matrix Rust RN POC';
let sdkReadyPromise: Promise<void> | undefined;

type MatrixClient = Awaited<ReturnType<ClientBuilder['build']>>;
type MatrixSyncService = Awaited<ReturnType<ReturnType<MatrixClient['syncService']>['finish']>>;
type MatrixRoom = ReturnType<MatrixClient['rooms']>[number];
type MatrixTimeline = Awaited<ReturnType<MatrixRoom['timeline']>>;
type MatrixTaskHandle = Awaited<ReturnType<MatrixTimeline['addListener']>>;
type RoomSummary = {
  id: string;
  name: string;
  topic?: string;
  avatarUrl?: string;
  membership: string;
  latestMessage?: string;
  latestTimestamp?: number;
  hint?: string;
};
type MediaDescriptor = {
  filename: string;
  mimeType: string;
  source: ReturnType<typeof MediaSource.fromJson>;
};
type RenderableMessage = {
  id: string;
  sender: string;
  body: string;
  timestamp: number;
  isOwn: boolean;
  media?: MediaDescriptor;
  kind: 'text' | 'image' | 'file' | 'audio' | 'video' | 'notice' | 'other';
};

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function sessionStoreKey(session?: Session): string {
  if (!session) {
    return 'guest';
  }

  return sanitizePathPart(`${session.userId}__${session.deviceId}`);
}

function normalizeFilePath(uriOrPath: string | null | undefined): string | undefined {
  if (!uriOrPath) {
    return undefined;
  }

  if (uriOrPath.startsWith('file://')) {
    return uriOrPath.slice(7);
  }

  return uriOrPath;
}

function toMillis(value: unknown): number {
  if (typeof value === 'bigint') {
    return Number(value);
  }

  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  if (value && typeof value === 'object' && 'toString' in value) {
    const parsed = Number(String(value));
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  return Date.now();
}

function formatTimestamp(value?: number): string {
  if (!value) {
    return '';
  }

  try {
    return new Date(value).toLocaleString();
  } catch {
    return '';
  }
}

function formatMatrixError(error: unknown): string {
  if (ClientError.instanceOf(error)) {
    if (error.tag === 'MatrixApi') {
      const details = [error.inner.msg, error.inner.code, error.inner.details]
        .filter(Boolean)
        .join(' | ');
      return details || 'Matrix API error';
    }

    if (error.tag === 'Generic') {
      const details = [error.inner.msg, error.inner.details].filter(Boolean).join(' | ');
      return details || 'Client error';
    }
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function assertSlidingSyncSupported(slidingSyncVersion: SlidingSyncVersion): void {
  if (slidingSyncVersion === SlidingSyncVersion.None) {
    throw new Error(
      'This homeserver does not advertise Sliding Sync support. The current POC uses Matrix Rust SDK syncService/room-list APIs, so Sliding Sync must be enabled on Synapse or provided via a Sliding Sync proxy before login can complete.',
    );
  }
}

async function resolveSlidingSyncVersion(client: MatrixClient): Promise<SlidingSyncVersion> {
  const loginDetails = await client.homeserverLoginDetails();
  const homeserverVersion = loginDetails.slidingSyncVersion();
  if (homeserverVersion === SlidingSyncVersion.Native) {
    return homeserverVersion;
  }

  const availableVersions = await client.availableSlidingSyncVersions();
  if (availableVersions.includes(SlidingSyncVersion.Native)) {
    return SlidingSyncVersion.Native;
  }

  return homeserverVersion;
}

function summarizeBridgeRoom(roomInfo: RoomInfo): string | undefined {
  const candidates = [
    roomInfo.displayName,
    roomInfo.topic,
    roomInfo.canonicalAlias,
    roomInfo.rawName,
  ].filter(Boolean) as string[];
  const text = candidates.join(' ').toLowerCase();

  if (text.includes('whatsapp') || text.includes('mautrix-whatsapp')) {
    return 'WhatsApp bridge';
  }

  if (text.includes('email') || text.includes('postmoogle')) {
    return 'Email bridge';
  }

  return undefined;
}

function membershipToString(value: MatrixRoom['membership'] extends () => infer T ? T : never): string {
  switch (value) {
    case Membership.Joined:
      return 'join';
    case Membership.Invited:
      return 'invite';
    case Membership.Left:
      return 'leave';
    case Membership.Knocked:
      return 'knock';
    case Membership.Banned:
      return 'ban';
    default:
      return String(value).toLowerCase();
  }
}

function isRoomIdentifier(value: string): boolean {
  return value.startsWith('!') || value.startsWith('#');
}

function eventOrTransactionIdToString(value: EventTimelineItem['eventOrTransactionId']): string {
  return value.tag === 'EventId' ? value.inner.eventId : value.inner.transactionId;
}

function profileDisplayName(
  profile: EventTimelineItem['senderProfile'],
  fallback: string,
): string {
  return profile.tag === 'Ready' ? profile.inner.displayName ?? fallback : fallback;
}

function applyTimelineDiffs(current: TimelineItemLike[], diffs: TimelineDiff[]): TimelineItemLike[] {
  const next = [...current];

  for (const diff of diffs) {
    switch (diff.tag) {
      case 'Append':
        next.push(...diff.inner.values);
        break;
      case 'Clear':
        next.length = 0;
        break;
      case 'PushFront':
        next.unshift(diff.inner.value);
        break;
      case 'PushBack':
        next.push(diff.inner.value);
        break;
      case 'PopFront':
        next.shift();
        break;
      case 'PopBack':
        next.pop();
        break;
      case 'Insert':
        next.splice(diff.inner.index, 0, diff.inner.value);
        break;
      case 'Set':
        next[diff.inner.index] = diff.inner.value;
        break;
      case 'Remove':
        next.splice(diff.inner.index, 1);
        break;
      case 'Truncate':
        next.length = diff.inner.length;
        break;
      case 'Reset':
        next.length = 0;
        next.push(...diff.inner.values);
        break;
      default:
        break;
    }
  }

  return next;
}

function renderEventPreview(event?: EventTimelineItem): string | undefined {
  if (!event) {
    return undefined;
  }

  const content = event.content;
  if (content.tag !== 'MsgLike') {
    return event.sender;
  }

  const kind = content.inner.content.kind;

  switch (kind.tag) {
    case 'Message':
      return kind.inner.content.body;
    case 'Sticker':
      return '[Sticker]';
    case 'Poll':
      return `[Poll] ${kind.inner.question}`;
    case 'Redacted':
      return '[Redacted]';
    case 'UnableToDecrypt':
      return '[Encrypted message]';
    case 'Other':
      return '[Unsupported message]';
    default:
      return '[Message]';
  }
}

function mapTimelineItem(item: TimelineItemLike): RenderableMessage | undefined {
  const event = item.asEvent();
  if (!event) {
    return undefined;
  }

  const content = event.content;
  if (content.tag !== 'MsgLike') {
    return undefined;
  }

  const kind = content.inner.content.kind;
  const id = eventOrTransactionIdToString(event.eventOrTransactionId) || item.uniqueId().id;

  if (kind.tag === 'Message') {
    const messageType = kind.inner.content.msgType;

    switch (messageType.tag) {
      case 'Text':
        return {
          id,
          sender: profileDisplayName(event.senderProfile, event.sender),
          body: messageType.inner.content.body,
          timestamp: toMillis(event.timestamp),
          isOwn: event.isOwn,
          kind: 'text',
        };
      case 'Notice':
        return {
          id,
          sender: profileDisplayName(event.senderProfile, event.sender),
          body: messageType.inner.content.body,
          timestamp: toMillis(event.timestamp),
          isOwn: event.isOwn,
          kind: 'notice',
        };
      case 'Image':
        return {
          id,
          sender: profileDisplayName(event.senderProfile, event.sender),
          body: messageType.inner.content.caption ?? messageType.inner.content.filename,
          timestamp: toMillis(event.timestamp),
          isOwn: event.isOwn,
          kind: 'image',
          media: {
            filename: messageType.inner.content.filename,
            mimeType:
              messageType.inner.content.info?.mimetype ?? 'image/*',
            source: MediaSource.fromJson(messageType.inner.content.source.toJson()),
          },
        };
      case 'File':
        return {
          id,
          sender: profileDisplayName(event.senderProfile, event.sender),
          body: messageType.inner.content.caption ?? messageType.inner.content.filename,
          timestamp: toMillis(event.timestamp),
          isOwn: event.isOwn,
          kind: 'file',
          media: {
            filename: messageType.inner.content.filename,
            mimeType:
              messageType.inner.content.info?.mimetype ??
              'application/octet-stream',
            source: MediaSource.fromJson(messageType.inner.content.source.toJson()),
          },
        };
      case 'Audio':
        return {
          id,
          sender: profileDisplayName(event.senderProfile, event.sender),
          body: messageType.inner.content.caption ?? messageType.inner.content.filename,
          timestamp: toMillis(event.timestamp),
          isOwn: event.isOwn,
          kind: 'audio',
          media: {
            filename: messageType.inner.content.filename,
            mimeType:
              messageType.inner.content.info?.mimetype ?? 'audio/*',
            source: MediaSource.fromJson(messageType.inner.content.source.toJson()),
          },
        };
      case 'Video':
        return {
          id,
          sender: profileDisplayName(event.senderProfile, event.sender),
          body: messageType.inner.content.caption ?? messageType.inner.content.filename,
          timestamp: toMillis(event.timestamp),
          isOwn: event.isOwn,
          kind: 'video',
          media: {
            filename: messageType.inner.content.filename,
            mimeType:
              messageType.inner.content.info?.mimetype ?? 'video/*',
            source: MediaSource.fromJson(messageType.inner.content.source.toJson()),
          },
        };
      default:
        return {
          id,
          sender: profileDisplayName(event.senderProfile, event.sender),
          body: `[${messageType.tag}]`,
          timestamp: toMillis(event.timestamp),
          isOwn: event.isOwn,
          kind: 'other',
        };
    }
  }

  if (kind.tag === 'UnableToDecrypt') {
    return {
      id,
      sender: profileDisplayName(event.senderProfile, event.sender),
      body: '[Unable to decrypt older message on this device]',
      timestamp: toMillis(event.timestamp),
      isOwn: event.isOwn,
      kind: 'other',
    };
  }

  return {
    id,
    sender: profileDisplayName(event.senderProfile, event.sender),
    body: `[${kind.tag}]`,
    timestamp: toMillis(event.timestamp),
    isOwn: event.isOwn,
    kind: 'other',
  };
}

function eventOrTransactionIdLikeToString(
  value: {tag: string; inner: {eventId?: string; transactionId?: string}},
): string {
  return value.tag === 'EventId' ? value.inner.eventId ?? '' : value.inner.transactionId ?? '';
}

function mapEmbeddedLatestEvent(
  details: any,
  ownUserId: string,
): RenderableMessage | undefined {
  if (details.tag !== 'Ready') {
    return undefined;
  }

  const {content, sender, timestamp, eventOrTransactionId} = details.inner;
  if (content.tag !== 'MsgLike') {
    return undefined;
  }

  const kind = content.inner.content.kind;
  const id = eventOrTransactionIdLikeToString(eventOrTransactionId);
  const isOwn = sender === ownUserId;

  if (kind.tag === 'Message') {
    const messageType = kind.inner.content.msgType;

    switch (messageType.tag) {
      case 'Text':
        return {
          id,
          sender,
          body: messageType.inner.content.body,
          timestamp: toMillis(timestamp),
          isOwn,
          kind: 'text',
        };
      case 'Notice':
        return {
          id,
          sender,
          body: messageType.inner.content.body,
          timestamp: toMillis(timestamp),
          isOwn,
          kind: 'notice',
        };
      case 'Image':
        return {
          id,
          sender,
          body: messageType.inner.content.caption ?? messageType.inner.content.filename,
          timestamp: toMillis(timestamp),
          isOwn,
          kind: 'image',
          media: {
            filename: messageType.inner.content.filename,
            mimeType: messageType.inner.content.info?.mimetype ?? 'image/*',
            source: MediaSource.fromJson(messageType.inner.content.source.toJson()),
          },
        };
      case 'File':
        return {
          id,
          sender,
          body: messageType.inner.content.caption ?? messageType.inner.content.filename,
          timestamp: toMillis(timestamp),
          isOwn,
          kind: 'file',
          media: {
            filename: messageType.inner.content.filename,
            mimeType: messageType.inner.content.info?.mimetype ?? 'application/octet-stream',
            source: MediaSource.fromJson(messageType.inner.content.source.toJson()),
          },
        };
      default:
        return {
          id,
          sender,
          body: `[${messageType.tag}]`,
          timestamp: toMillis(timestamp),
          isOwn,
          kind: 'other',
        };
    }
  }

  if (kind.tag === 'UnableToDecrypt') {
    return {
      id,
      sender,
      body: '[Unable to decrypt older message on this device]',
      timestamp: toMillis(timestamp),
      isOwn,
      kind: 'other',
    };
  }

  return {
    id,
    sender,
    body: `[${kind.tag}]`,
    timestamp: toMillis(timestamp),
    isOwn,
    kind: 'other',
  };
}

async function ensureSdkReady() {
  if (!sdkReadyPromise) {
    sdkReadyPromise = (async () => {
      const logsDir = `${RNFS.DocumentDirectoryPath}/matrix-rust-rn-poc/logs`;
      await RNFS.mkdir(logsDir);
      await uniffiInitAsync();
      initPlatform(
        TracingConfiguration.new({
          logLevel: LogLevel.Info,
          traceLogPacks: [TraceLogPacks.Timeline, TraceLogPacks.EventCache],
          extraTargets: [],
          writeToStdoutOrSystem: true,
          writeToFiles: {
            path: logsDir,
            filePrefix: 'matrix-rust-rn-poc',
          },
        }),
        false,
      );
    })().catch(error => {
      sdkReadyPromise = undefined;
      throw error;
    });
  }

  await sdkReadyPromise;
}

async function buildClient(
  homeserverUrl: string,
  session?: Session,
  storeKey?: string,
): Promise<MatrixClient> {
  const sessionKey = storeKey ?? sessionStoreKey(session);
  const storeRoot = `${RNFS.DocumentDirectoryPath}/matrix-rust-rn-poc/${sessionKey}`;
  const dataPath = `${storeRoot}/data`;
  const cachePath = `${storeRoot}/cache`;

  await RNFS.mkdir(dataPath);
  await RNFS.mkdir(cachePath);

  const slidingSyncVersionBuilder =
    session?.slidingSyncVersion === SlidingSyncVersion.Native
      ? SlidingSyncVersionBuilder.Native
      : SlidingSyncVersionBuilder.None;

  const builder = new ClientBuilder()
    .homeserverUrl(homeserverUrl)
    .sessionPaths(dataPath, cachePath)
    .slidingSyncVersionBuilder(slidingSyncVersionBuilder)
    .userAgent('MatrixRustRnPoc/0.0.1');

  return builder.build();
}

function createEphemeralLoginStoreKey(): string {
  return `login-${Date.now()}`;
}

async function collectRoomSummaries(client: MatrixClient): Promise<RoomSummary[]> {
  const rooms = client.rooms();
  const summaries = await Promise.all(
    rooms.map(async room => {
      const [roomInfo, latestEvent] = await Promise.all([
        room.roomInfo(),
        room.latestEvent(),
      ]);

      return {
        id: room.id(),
        name: roomInfo.displayName ?? room.displayName() ?? room.id(),
        topic: roomInfo.topic,
        avatarUrl: roomInfo.avatarUrl,
        membership: membershipToString(room.membership()),
        latestMessage: renderEventPreview(latestEvent),
        latestTimestamp: latestEvent ? toMillis(latestEvent.timestamp) : undefined,
        hint: summarizeBridgeRoom(roomInfo),
      };
    }),
  );

  return summaries
    .filter(room => room.membership === 'join' || room.membership === 'invite')
    .sort(
    (left, right) => (right.latestTimestamp ?? 0) - (left.latestTimestamp ?? 0),
    );
}

function App(): React.JSX.Element {
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [syncState, setSyncState] = useState('idle');
  const [status, setStatus] = useState('Starting Matrix Rust SDK...');
  const [homeserverUrl, setHomeserverUrl] = useState(DEFAULT_HOMESERVER);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [bridgeAlias, setBridgeAlias] = useState('');
  const [messageDraft, setMessageDraft] = useState('');
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [timelineItems, setTimelineItems] = useState<TimelineItemLike[]>([]);
  const [latestEventFallback, setLatestEventFallback] = useState<RenderableMessage>();
  const [activeRoomId, setActiveRoomId] = useState<string>();
  const [downloadStatus, setDownloadStatus] = useState('');
  const [sessionLabel, setSessionLabel] = useState('');
  const {width} = useWindowDimensions();
  const isCompactLayout = width < 900;
  const autoSelectFirstRoomRef = useRef(true);

  const clientRef = useRef<MatrixClient>();
  const syncServiceRef = useRef<MatrixSyncService>();
  const roomRefreshIntervalRef = useRef<ReturnType<typeof setInterval>>();
  const timelineRef = useRef<MatrixTimeline>();
  const timelineTaskHandleRef = useRef<MatrixTaskHandle>();
  const messagesListRef = useRef<FlatList<RenderableMessage>>(null);

  const visibleMessages = useMemo(
    () =>
      timelineItems
        .map(mapTimelineItem)
        .filter((item): item is RenderableMessage => Boolean(item)),
    [timelineItems],
  );

  const displayedMessages = useMemo(() => {
    if (!latestEventFallback) {
      return visibleMessages;
    }

    if (visibleMessages.some(message => message.id === latestEventFallback.id)) {
      return visibleMessages;
    }

    return [...visibleMessages, latestEventFallback];
  }, [latestEventFallback, visibleMessages]);

  useEffect(() => {
    if (!activeRoomId || displayedMessages.length === 0) {
      return;
    }

    const timeout = setTimeout(() => {
      messagesListRef.current?.scrollToEnd({animated: true});
    }, 50);

    return () => clearTimeout(timeout);
  }, [activeRoomId, displayedMessages.length]);

  const stopSync = useCallback(async () => {
    if (syncServiceRef.current) {
      try {
        await syncServiceRef.current.stop();
      } catch {
        // Ignore shutdown noise during logout/unmount.
      }
    }
    syncServiceRef.current = undefined;
  }, []);

  const stopTimeline = useCallback(async () => {
    timelineTaskHandleRef.current?.cancel();
    timelineTaskHandleRef.current = undefined;
    timelineRef.current = undefined;
    setTimelineItems([]);
    setLatestEventFallback(undefined);
  }, []);

  const refreshActiveRoomLatestEvent = useCallback(async (room: MatrixRoom) => {
    try {
      const latestEvent = await room.latestEvent();
      const ownUserId = room.ownUserId();
      setLatestEventFallback(mapEmbeddedLatestEvent(latestEvent, ownUserId));
    } catch {
      // Ignore fallback failures; the timeline listener remains the primary source.
    }
  }, []);

  useEffect(() => {
    if (!activeRoomId) {
      return;
    }

    const client = clientRef.current;
    const room = client?.rooms().find(candidate => candidate.id() === activeRoomId);
    if (!room) {
      return;
    }

    refreshActiveRoomLatestEvent(room).catch(() => undefined);
    const interval = setInterval(() => {
      refreshActiveRoomLatestEvent(room).catch(() => undefined);
    }, 3000);

    return () => clearInterval(interval);
  }, [activeRoomId, refreshActiveRoomLatestEvent]);

  const refreshRooms = useCallback(async (client = clientRef.current) => {
    if (!client) {
      return;
    }

    try {
      const nextRooms = await collectRoomSummaries(client);
      startTransition(() => {
        setRooms(nextRooms);
      });

      if (autoSelectFirstRoomRef.current && !activeRoomId && nextRooms.length > 0) {
        setActiveRoomId(nextRooms[0].id);
        autoSelectFirstRoomRef.current = false;
      }
    } catch (error) {
      setStatus(`Room refresh failed: ${formatMatrixError(error)}`);
    }
  }, [activeRoomId]);

  const startClientRuntime = useCallback(async (client: MatrixClient, session?: Session) => {
    clientRef.current = client;
    setSessionLabel(session ? `${session.userId} on ${session.homeserverUrl}` : '');

    setStatus('Preparing sync service...');
    const syncServiceBuilder = client.syncService();
    const syncService = await syncServiceBuilder.finish();
    syncServiceRef.current = syncService;

    syncService.state({
      onUpdate(state) {
        setSyncState(String(state));
      },
    });

    setStatus('Starting sync...');
    await syncService.start();
    setStatus('Loading rooms...');
    await refreshRooms(client);

    if (roomRefreshIntervalRef.current) {
      clearInterval(roomRefreshIntervalRef.current);
    }

    roomRefreshIntervalRef.current = setInterval(() => {
      refreshRooms(clientRef.current).catch(() => undefined);
    }, 15000);
  }, [refreshRooms]);

  useEffect(() => {
    let disposed = false;

    async function bootstrap() {
      try {
        await ensureSdkReady();
        const stored = await AsyncStorage.getItem(SESSION_KEY);
        if (!stored) {
          if (!disposed) {
            setStatus('Ready to log in.');
            setIsBootstrapping(false);
          }
          return;
        }

        const session = JSON.parse(stored) as Session;
        assertSlidingSyncSupported(session.slidingSyncVersion);
        setStatus(`Restoring ${session.userId}...`);
        const client = await buildClient(session.homeserverUrl, session);
        await client.restoreSession(session);
        await startClientRuntime(client, session);

        if (!disposed) {
          setHomeserverUrl(session.homeserverUrl);
          setStatus(`Restored ${session.userId}`);
          setSessionLabel(`${session.userId} on ${session.homeserverUrl}`);
          setIsBootstrapping(false);
        }
      } catch (error) {
        if (!disposed) {
          await AsyncStorage.removeItem(SESSION_KEY);
          clientRef.current = undefined;
          syncServiceRef.current = undefined;
          setStatus(`Bootstrap failed: ${formatMatrixError(error)}`);
          setIsBootstrapping(false);
        }
      }
    }

    bootstrap().catch(() => undefined);

    return () => {
      disposed = true;
      stopTimeline().catch(() => undefined);
      stopSync().catch(() => undefined);
      if (roomRefreshIntervalRef.current) {
        clearInterval(roomRefreshIntervalRef.current);
      }
    };
  }, [startClientRuntime, stopSync, stopTimeline]);

  async function handleLogin() {
    if (!homeserverUrl || !username || !password) {
      Alert.alert('Missing details', 'Homeserver, username, and password are required.');
      return;
    }

    setAuthBusy(true);
    setStatus('Logging in...');

    try {
      await stopTimeline();
      await stopSync();

      setStatus('Preparing login client...');
      const loginClient = await buildClient(
        homeserverUrl,
        undefined,
        createEphemeralLoginStoreKey(),
      );
      await loginClient.login(username, password, DEFAULT_DEVICE_NAME, undefined);
      const slidingSyncVersion = await resolveSlidingSyncVersion(loginClient);
      assertSlidingSyncSupported(slidingSyncVersion);

      const session = {
        ...loginClient.session(),
        slidingSyncVersion,
      };
      await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));

      // Rebuild the client using the authenticated user's store path instead of
      // continuing on the temporary pre-login "guest" store.
      setStatus('Rebuilding client for authenticated session...');
      const client = await buildClient(session.homeserverUrl, session);
      await client.restoreSession(session);
      await startClientRuntime(client, session);

      setStatus(`Logged in as ${session.userId}`);
      setSessionLabel(`${session.userId} on ${session.homeserverUrl}`);
    } catch (error) {
      setStatus(`Login failed: ${formatMatrixError(error)}`);
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogout() {
    const client = clientRef.current;
    if (!client) {
      return;
    }

    setAuthBusy(true);
    setStatus('Logging out...');

    try {
      await stopTimeline();
      await stopSync();
      await client.logout();
      clientRef.current = undefined;
      await AsyncStorage.removeItem(SESSION_KEY);
      setRooms([]);
      setActiveRoomId(undefined);
      autoSelectFirstRoomRef.current = true;
      setSessionLabel('');
      setStatus('Logged out.');
    } catch (error) {
      setStatus(`Logout failed: ${formatMatrixError(error)}`);
    } finally {
      setAuthBusy(false);
    }
  }

  async function openRoom(roomId: string) {
    const client = clientRef.current;
    if (!client) {
      return;
    }

    const room = client.rooms().find(candidate => candidate.id() === roomId);
    if (!room) {
      return;
    }

    setActiveRoomId(roomId);
    setStatus(`Opening ${roomId}`);
    await stopTimeline();

    try {
      const membership = membershipToString(room.membership());
      if (membership !== 'join') {
        if (membership === 'invite' || membership === 'leave') {
          setStatus(`Joining ${room.displayName() ?? room.id()}...`);
          await room.join();
          await refreshRooms(client);
        } else {
          throw new Error(`Room is not joined yet (membership: ${membership}).`);
        }
      }

      const timeline = await room.timeline();
      timelineRef.current = timeline;
      await refreshActiveRoomLatestEvent(room);

      const listenerHandle = await timeline.addListener({
        onUpdate(diffs) {
          startTransition(() => {
            setTimelineItems(current => applyTimelineDiffs(current, diffs));
          });
        },
      });

      timelineTaskHandleRef.current = listenerHandle;
      await timeline.paginateBackwards(30);
      await timeline.paginateForwards(30);
      await timeline.markAsRead(ReceiptType.Read);
      setStatus(`Viewing ${room.displayName() ?? room.id()}`);
    } catch (error) {
      setStatus(`Failed to load room timeline: ${formatMatrixError(error)}`);
    }
  }

  async function handleSendMessage() {
    const timeline = timelineRef.current;
    const trimmed = messageDraft.trim();

    if (!timeline || !trimmed) {
      return;
    }

    try {
      const content = timeline.createMessageContent(
        MessageType.Text.new({
          content: TextMessageContent.new({ body: trimmed }),
        }),
      );

      if (!content) {
        throw new Error('Could not create text message content.');
      }

      await timeline.send(content);
      setMessageDraft('');
      setStatus('Message queued.');
      await refreshRooms();
    } catch (error) {
      setStatus(`Send failed: ${formatMatrixError(error)}`);
    }
  }

  async function handlePickAndUpload() {
    const timeline = timelineRef.current;
    if (!timeline) {
      Alert.alert('No room selected', 'Open a room before uploading media.');
      return;
    }

    try {
      const picked = await DocumentPicker.pickSingle({
        type: [DocumentPicker.types.allFiles],
        copyTo: 'cachesDirectory',
        presentationStyle: 'fullScreen',
      });

      const path = normalizeFilePath(picked.fileCopyUri ?? picked.uri);
      if (!path) {
        throw new Error('Document picker did not return a readable file path.');
      }

      const stats = await RNFS.stat(path);
      const source = UploadSource.File.new({ filename: path });
      const params = UploadParameters.new({ source });
      const mimeType = picked.type ?? 'application/octet-stream';
      const size = BigInt(stats.size);

      if (mimeType.startsWith('image/')) {
        const handle = timeline.sendImage(
          params,
          undefined,
          ImageInfo.new({ mimetype: mimeType, size }),
        );
        await handle.join();
      } else {
        const handle = timeline.sendFile(
          params,
          FileInfo.new({ mimetype: mimeType, size }),
        );
        await handle.join();
      }

      setStatus(`Uploaded ${picked.name ?? 'attachment'}`);
      await refreshRooms();
    } catch (error) {
      if (DocumentPicker.isCancel(error)) {
        return;
      }
      setStatus(`Upload failed: ${String(error)}`);
    }
  }

  async function handleDownload(media: MediaDescriptor) {
    const client = clientRef.current;
    if (!client) {
      return;
    }

    try {
      const downloadsDir = `${RNFS.DocumentDirectoryPath}/matrix-rust-rn-poc/downloads`;
      await RNFS.mkdir(downloadsDir);

      const target = `${downloadsDir}/${Date.now()}-${sanitizePathPart(media.filename)}`;
      const handle = await client.getMediaFile(
        media.source,
        media.filename,
        media.mimeType,
        true,
        downloadsDir,
      );

      const persisted = handle.persist(target);
      const finalPath = persisted ? target : handle.path();
      setDownloadStatus(finalPath);
      setStatus(`Downloaded ${media.filename}`);
    } catch (error) {
      setStatus(`Download failed: ${String(error)}`);
    }
  }

  async function handleJoinBridgeRoom() {
    const client = clientRef.current;
    const roomIdOrAlias = bridgeAlias.trim();

    if (!client || !roomIdOrAlias) {
      return;
    }

    if (!isRoomIdentifier(roomIdOrAlias)) {
      setStatus(
        'Could not join room: enter a Matrix room alias (`#room:domain`) or room ID (`!roomId:domain`), not a user ID like `@user:domain`.',
      );
      return;
    }

    try {
      const joinedRoom = await client.joinRoomByIdOrAlias(roomIdOrAlias, []);
      setBridgeAlias('');
      setStatus(`Joined ${joinedRoom.displayName() ?? joinedRoom.id()}`);
      await refreshRooms();
      await openRoom(joinedRoom.id());
    } catch (error) {
      setStatus(`Could not join room: ${formatMatrixError(error)}`);
    }
  }

  const activeRoomSummary = rooms.find(room => room.id === activeRoomId);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor="#0a1424" />
      <View style={styles.shell}>
        <View style={styles.header}>
          <Text style={styles.eyebrow}>Matrix Rust SDK React Native POC</Text>
          <Text style={styles.title}>Synapse-native mobile chat reference</Text>
          <Text style={styles.subtitle}>
            Direct Matrix client with login, sync, chat, upload/download, and bridge-room access for
            `mautrix-whatsapp` and `postmoogle`.
          </Text>
        </View>

        <View style={styles.banner}>
          <Text style={styles.bannerText}>{status}</Text>
          <Text style={styles.bannerMeta}>
            Sync: {syncState} {sessionLabel ? `| ${sessionLabel}` : ''}
          </Text>
          {downloadStatus ? (
            <Text style={styles.bannerMeta}>Last download: {downloadStatus}</Text>
          ) : null}
        </View>

        {isBootstrapping ? (
          <View style={styles.centered}>
            <ActivityIndicator color="#f3c95b" size="large" />
            <Text style={styles.loadingText}>Restoring Matrix session...</Text>
          </View>
        ) : !clientRef.current ? (
          <ScrollView contentContainerStyle={styles.authScroll}>
            <View style={styles.panel}>
              <Text style={styles.panelTitle}>Login</Text>
              <Text style={styles.panelText}>
                Use the same Synapse credentials your backend provisions through shared-secret registration.
              </Text>

              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Homeserver URL"
                placeholderTextColor="#7a8798"
                style={styles.input}
                value={homeserverUrl}
                onChangeText={setHomeserverUrl}
              />
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="@username:domain or localpart"
                placeholderTextColor="#7a8798"
                style={styles.input}
                value={username}
                onChangeText={setUsername}
              />
              <TextInput
                placeholder="Password"
                placeholderTextColor="#7a8798"
                secureTextEntry
                style={styles.input}
                value={password}
                onChangeText={setPassword}
              />

              <Pressable disabled={authBusy} onPress={handleLogin} style={styles.primaryButton}>
                <Text style={styles.primaryButtonText}>
                  {authBusy ? 'Signing in...' : 'Login with Matrix'}
                </Text>
              </Pressable>

              <View style={styles.tipBox}>
                <Text style={styles.tipTitle}>Bridge note</Text>
                <Text style={styles.tipText}>
                  WhatsApp and email rooms do not need custom mobile transport. Once `mautrix-whatsapp`
                  and `postmoogle` are bridged into Synapse, this app opens them as ordinary Matrix rooms.
                </Text>
              </View>
            </View>
          </ScrollView>
        ) : (
          <View style={[styles.workspace, isCompactLayout && styles.workspaceCompact]}>
            {(!isCompactLayout || !activeRoomId) ? (
            <View style={[styles.leftRail, isCompactLayout && styles.leftRailCompact]}>
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Bridge Rooms</Text>
                <Text style={styles.panelText}>
                  Join an existing bridged room by Matrix room ID or alias.
                </Text>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="#alias:domain or !roomId:domain"
                  placeholderTextColor="#7a8798"
                  style={styles.input}
                  value={bridgeAlias}
                  onChangeText={setBridgeAlias}
                />
                <Pressable onPress={handleJoinBridgeRoom} style={styles.secondaryButton}>
                  <Text style={styles.secondaryButtonText}>Join WhatsApp / Email Room</Text>
                </Pressable>
              </View>

              <View style={styles.panelFlex}>
                <View style={styles.roomHeader}>
                  <Text style={styles.panelTitle}>Rooms</Text>
                  <Pressable onPress={() => refreshRooms()} style={styles.linkButton}>
                    <Text style={styles.linkButtonText}>Refresh</Text>
                  </Pressable>
                </View>

                <FlatList
                  data={rooms}
                  keyExtractor={item => item.id}
                  renderItem={({ item }) => (
                    <Pressable
                      onPress={() => openRoom(item.id)}
                      style={[
                        styles.roomCard,
                        item.id === activeRoomId && styles.roomCardActive,
                      ]}>
                      <Text style={styles.roomName}>{item.name}</Text>
                      <Text style={styles.roomMeta}>{item.id}</Text>
                      {item.hint ? <Text style={styles.roomHint}>{item.hint}</Text> : null}
                      {item.latestMessage ? (
                        <Text numberOfLines={2} style={styles.roomPreview}>
                          {item.latestMessage}
                        </Text>
                      ) : null}
                    </Pressable>
                  )}
                  ListEmptyComponent={
                    <Text style={styles.emptyText}>No rooms yet. Join one or wait for sync.</Text>
                  }
                />
              </View>

              <Pressable disabled={authBusy} onPress={handleLogout} style={styles.ghostButton}>
                <Text style={styles.ghostButtonText}>
                  {authBusy ? 'Working...' : 'Logout'}
                </Text>
              </Pressable>
            </View>
            ) : null}

            {(!isCompactLayout || activeRoomId) ? (
            <View style={styles.chatPane}>
              <View style={styles.chatHeader}>
                {isCompactLayout ? (
                  <Pressable
                    onPress={() => {
                      autoSelectFirstRoomRef.current = false;
                      setActiveRoomId(undefined);
                    }}
                    style={styles.linkButton}>
                    <Text style={styles.linkButtonText}>Back to rooms</Text>
                  </Pressable>
                ) : null}
                <Text style={styles.chatTitle}>
                  {activeRoomSummary?.name ?? 'Select a room'}
                </Text>
                <Text style={styles.chatSubtitle}>
                  {activeRoomSummary?.hint ?? activeRoomSummary?.topic ?? activeRoomSummary?.id ?? ''}
                </Text>
              </View>

              <FlatList
                ref={messagesListRef}
                contentContainerStyle={styles.messages}
                data={displayedMessages}
                keyExtractor={item => item.id}
                onContentSizeChange={() => {
                  messagesListRef.current?.scrollToEnd({animated: false});
                }}
                renderItem={({ item }) => (
                  <View
                    style={[
                      styles.messageBubble,
                      item.isOwn ? styles.ownBubble : styles.otherBubble,
                    ]}>
                    <Text
                      style={[
                        styles.messageSender,
                        item.isOwn ? styles.ownSender : styles.otherSender,
                      ]}>
                      {item.sender}
                    </Text>
                    <Text
                      style={[
                        styles.messageBody,
                        item.isOwn ? styles.ownMessageBody : styles.otherMessageBody,
                      ]}>
                      {item.body}
                    </Text>
                    {item.media ? (
                      <Pressable
                        onPress={() => handleDownload(item.media!)}
                        style={styles.mediaButton}>
                        <Text
                          style={[
                            styles.mediaButtonText,
                            item.isOwn ? styles.ownMediaButtonText : styles.otherMediaButtonText,
                          ]}>
                          Download {item.media.filename}
                        </Text>
                      </Pressable>
                    ) : null}
                    <Text
                      style={[
                        styles.messageTime,
                        item.isOwn ? styles.ownMessageTime : styles.otherMessageTime,
                      ]}>
                      {formatTimestamp(item.timestamp)}
                    </Text>
                  </View>
                )}
                ListEmptyComponent={
                  <View style={styles.emptyTimeline}>
                    <Text style={styles.emptyText}>
                      {activeRoomId
                        ? 'Timeline is empty or still syncing.'
                        : 'Choose a room from the left to start chatting.'}
                    </Text>
                  </View>
                }
              />

              <View style={styles.composer}>
                <TextInput
                  editable={Boolean(activeRoomId)}
                  multiline
                  placeholder="Write a message..."
                  placeholderTextColor="#7a8798"
                  style={styles.composerInput}
                  value={messageDraft}
                  onChangeText={setMessageDraft}
                />
                <View style={styles.composerActions}>
                  <Pressable
                    disabled={!activeRoomId}
                    onPress={handlePickAndUpload}
                    style={styles.secondaryButton}>
                    <Text style={styles.secondaryButtonText}>Upload</Text>
                  </Pressable>
                  <Pressable
                    disabled={!activeRoomId}
                    onPress={handleSendMessage}
                    style={styles.primaryButton}>
                    <Text style={styles.primaryButtonText}>Send</Text>
                  </Pressable>
                </View>
              </View>
            </View>
            ) : null}
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#0a1424',
  },
  shell: {
    flex: 1,
    backgroundColor: '#0f1d32',
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1e2e47',
    backgroundColor: '#10203a',
  },
  eyebrow: {
    color: '#f3c95b',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  title: {
    color: '#f7fbff',
    fontSize: 24,
    fontWeight: '800',
    marginTop: 6,
  },
  subtitle: {
    color: '#b8c4d3',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
  },
  banner: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: '#142742',
    borderBottomWidth: 1,
    borderBottomColor: '#213655',
  },
  bannerText: {
    color: '#f7fbff',
    fontSize: 14,
    fontWeight: '600',
  },
  bannerMeta: {
    color: '#95a7bc',
    fontSize: 12,
    marginTop: 4,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    color: '#dbe7f4',
    fontSize: 14,
  },
  authScroll: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 20,
  },
  panel: {
    backgroundColor: '#13253e',
    borderRadius: 18,
    padding: 18,
    borderWidth: 1,
    borderColor: '#213655',
    marginBottom: 16,
  },
  panelFlex: {
    flex: 1,
    backgroundColor: '#13253e',
    borderRadius: 18,
    padding: 18,
    borderWidth: 1,
    borderColor: '#213655',
    minHeight: 260,
  },
  panelTitle: {
    color: '#f7fbff',
    fontSize: 18,
    fontWeight: '700',
  },
  panelText: {
    color: '#9fb2c8',
    fontSize: 13,
    lineHeight: 18,
    marginTop: 6,
    marginBottom: 14,
  },
  input: {
    backgroundColor: '#0c1930',
    color: '#f7fbff',
    borderWidth: 1,
    borderColor: '#213655',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
  },
  primaryButton: {
    backgroundColor: '#f3c95b',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#2b2000',
    fontSize: 14,
    fontWeight: '800',
  },
  secondaryButton: {
    backgroundColor: '#1d3555',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    color: '#e6f0fb',
    fontSize: 14,
    fontWeight: '700',
  },
  ghostButton: {
    borderWidth: 1,
    borderColor: '#2a4263',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghostButtonText: {
    color: '#d6e3f2',
    fontSize: 14,
    fontWeight: '700',
  },
  linkButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  linkButtonText: {
    color: '#f3c95b',
    fontSize: 13,
    fontWeight: '700',
  },
  tipBox: {
    marginTop: 16,
    borderRadius: 14,
    backgroundColor: '#0f1d32',
    borderWidth: 1,
    borderColor: '#23395a',
    padding: 14,
  },
  tipTitle: {
    color: '#f7fbff',
    fontSize: 14,
    fontWeight: '700',
  },
  tipText: {
    color: '#9fb2c8',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 6,
  },
  workspace: {
    flex: 1,
    flexDirection: 'row',
    padding: 16,
    gap: 16,
  },
  workspaceCompact: {
    flexDirection: 'column',
  },
  leftRail: {
    width: 320,
    gap: 12,
  },
  leftRailCompact: {
    width: '100%',
    flex: 1,
  },
  roomHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  roomCard: {
    borderRadius: 14,
    backgroundColor: '#0d1a30',
    borderWidth: 1,
    borderColor: '#20324d',
    padding: 14,
    marginBottom: 10,
  },
  roomCardActive: {
    borderColor: '#f3c95b',
    backgroundColor: '#152846',
  },
  roomName: {
    color: '#f7fbff',
    fontSize: 14,
    fontWeight: '700',
  },
  roomMeta: {
    color: '#89a0b8',
    fontSize: 11,
    marginTop: 4,
  },
  roomHint: {
    color: '#f3c95b',
    fontSize: 11,
    marginTop: 6,
    fontWeight: '700',
  },
  roomPreview: {
    color: '#b6c5d6',
    fontSize: 12,
    marginTop: 8,
    lineHeight: 17,
  },
  chatPane: {
    flex: 1,
    backgroundColor: '#13253e',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#213655',
    overflow: 'hidden',
  },
  chatHeader: {
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#213655',
    backgroundColor: '#142742',
  },
  chatTitle: {
    color: '#f7fbff',
    fontSize: 18,
    fontWeight: '700',
  },
  chatSubtitle: {
    color: '#99acc2',
    fontSize: 12,
    marginTop: 4,
  },
  messages: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexGrow: 1,
  },
  messageBubble: {
    maxWidth: '84%',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 10,
  },
  ownBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#f3c95b',
  },
  otherBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#0d1a30',
    borderWidth: 1,
    borderColor: '#20324d',
  },
  messageSender: {
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 4,
  },
  ownSender: {
    color: '#7b6524',
  },
  otherSender: {
    color: '#f3c95b',
  },
  messageBody: {
    fontSize: 14,
    lineHeight: 20,
  },
  ownMessageBody: {
    color: '#112238',
  },
  otherMessageBody: {
    color: '#edf4fb',
  },
  messageTime: {
    fontSize: 10,
    marginTop: 8,
  },
  ownMessageTime: {
    color: '#5f6d7a',
  },
  otherMessageTime: {
    color: '#8ea4bc',
  },
  mediaButton: {
    marginTop: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(10,20,36,0.14)',
    paddingHorizontal: 10,
    paddingVertical: 8,
    alignSelf: 'flex-start',
  },
  mediaButtonText: {
    fontSize: 12,
    fontWeight: '700',
  },
  ownMediaButtonText: {
    color: '#112238',
  },
  otherMediaButtonText: {
    color: '#edf4fb',
  },
  composer: {
    borderTopWidth: 1,
    borderTopColor: '#213655',
    padding: 16,
    backgroundColor: '#112038',
  },
  composerInput: {
    minHeight: 52,
    maxHeight: 120,
    backgroundColor: '#0c1930',
    color: '#f7fbff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#213655',
    paddingHorizontal: 14,
    paddingVertical: 12,
    textAlignVertical: 'top',
  },
  composerActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 12,
  },
  emptyText: {
    color: '#97a9be',
    fontSize: 13,
    lineHeight: 18,
  },
  emptyTimeline: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
  },
});

export default App;
