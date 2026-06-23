import { ChangeEvent, FormEvent, Fragment, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Boxes,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Cpu,
  Download,
  Gamepad2,
  History,
  KeyRound,
  Layers3,
  ListChecks,
  LogOut,
  MessageSquare,
  Network,
  Plus,
  RefreshCw,
  Save,
  ScrollText,
  Search,
  SearchCheck,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
  Users,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import { apiFetch, formatDate, moneyMillicents, shortId, type AdminSession, type ApiRecord, type ListResponse } from './api';
import { buildPagedSearchParams, pageCount, pageRange } from './adminPagination';
import { useHashRoute } from './adminRoute';
import { SchemasView } from './SchemasView';
import {
  Background,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

type ViewKey =
  | 'users'
  | 'sessions'
  | 'games'
  | 'groups'
  | 'schemas'
  | 'schema-log'
  | 'models'
  | 'topics'
  | 'llm'
  | 'azure'
  | 'expertise'
  | 'ontology';

type RouteQuery = Record<string, string>;

interface ImportSummary {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
}

const LLM_KIND_LABELS: Record<string, string> = {
  support_consultation: 'Консультация поддержки',
  support_expertise_detection: 'Определение экспертизы',
  support_document_filter: 'Фильтр документов',
  support_compilation: 'Компиляция обращения',
  hint_generation: 'Генерация подсказки',
  narrative_generation: 'Генерация нарратива',
  world_state_evaluation: 'Учёт состояния',
  media_speech: 'Озвучка',
  media_image: 'Иллюстрация',
  media_transcription: 'Распознавание речи',
};

function llmKindLabel(kind: string): string {
  return LLM_KIND_LABELS[kind] ?? kind;
}

// Провайдеры LLM в формате конфига и их человекочитаемые названия.
const PROVIDER_LABELS: Record<string, string> = {
  OPENAI: 'OpenAI',
  GOOGLE: 'Google',
  OPENROUTER: 'OpenRouter',
  AZURE: 'Azure OpenAI',
};

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

const navItems: Array<{ key: ViewKey; label: string; icon: LucideIcon }> = [
  { key: 'users', label: 'Пользователи', icon: Users },
  { key: 'sessions', label: 'Сессии', icon: ListChecks },
  { key: 'games', label: 'Игры', icon: Gamepad2 },
  { key: 'groups', label: 'Группы', icon: Layers3 },
  { key: 'schemas', label: 'Схемы', icon: Workflow },
  { key: 'schema-log', label: 'Журнал схем', icon: ScrollText },
  { key: 'models', label: 'Модели', icon: SlidersHorizontal },
  { key: 'topics', label: 'Топики', icon: MessageSquare },
  { key: 'expertise', label: 'Экспертиза', icon: BookOpen },
  { key: 'ontology', label: 'Онтология', icon: Network },
  { key: 'llm', label: 'LLM запросы', icon: Cpu },
  { key: 'azure', label: 'Azure', icon: Boxes },
];

// Человекочитаемые названия типов схем для журнала исполнения (issue #255).
const SCHEMA_TYPE_LABELS: Record<string, string> = {
  action: 'Действие',
  hint: 'Подсказка',
  support: 'Поддержка',
  illustration: 'Иллюстрация',
};

function schemaTypeLabel(type: string): string {
  return SCHEMA_TYPE_LABELS[type] ?? type;
}

// Список допустимых разделов для hash-роутинга (issue #152). Неизвестный
// раздел в URL сбрасывается на первый.
const VIEW_KEYS: ViewKey[] = navItems.map((item) => item.key);
const DEFAULT_VIEW: ViewKey = 'users';

function field(row: ApiRecord | null | undefined, key: string): string {
  const value = row?.[key];
  if (value === null || value === undefined) return '';
  return String(value);
}

function recordField(row: ApiRecord | null | undefined, key: string): ApiRecord | null {
  const value = row?.[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as ApiRecord
    : null;
}

function fieldArray(row: ApiRecord | null | undefined, key: string): string[] {
  const value = row?.[key];
  return Array.isArray(value) ? value.map(String) : [];
}

function splitIds(value: string): string[] {
  return [...new Set(value.split(',').map((part) => part.trim()).filter(Boolean))].sort();
}

// Разбивает многострочный ввод на список непустых строк, сохраняя порядок и
// убирая дубликаты (используется для поисковых фраз документов экспертизы).
function splitLines(value: string): string[] {
  return [...new Set(value.split('\n').map((part) => part.trim()).filter(Boolean))];
}

// Разбивает ввод тэгов (через запятую) на список непустых строк, сохраняя
// порядок и убирая дубликаты (issue #321).
function splitTags(value: string): string[] {
  return [...new Set(value.split(',').map((part) => part.trim()).filter(Boolean))];
}

function jsonPreview(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

function fileTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function downloadJsonFile(filename: string, data: unknown): void {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function importSummaryText(summary: ImportSummary): string {
  return `Импортировано: ${summary.total}; создано: ${summary.created}; обновлено: ${summary.updated}; без изменений: ${summary.unchanged}.`;
}

function statusLabel(row: ApiRecord): string {
  if (row.is_processing === true) return 'обработка';
  if (row.is_active === true) return 'активна';
  return 'завершена';
}

function InlineIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon size={16} strokeWidth={2} aria-hidden="true" />;
}

function ToolbarButton({
  icon,
  children,
  onClick,
  type = 'button',
  disabled = false,
}: {
  icon: LucideIcon;
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  disabled?: boolean;
}) {
  return (
    <button className="button" type={type} onClick={onClick} disabled={disabled}>
      <InlineIcon icon={icon} />
      <span>{children}</span>
    </button>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

function ErrorLine({ message }: { message: string }) {
  if (!message) return null;
  return <div className="error-line">{message}</div>;
}

function MessageLine({ message }: { message: string }) {
  if (!message) return null;
  return <div className="message-line">{message}</div>;
}

function Pagination({
  page,
  total,
  onPageChange,
}: {
  page: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const totalPages = pageCount(total);
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const range = pageRange(total, safePage);

  return (
    <div className="pagination" aria-label="Постраничная навигация">
      <span className="pagination-summary">
        {range.from}-{range.to} из {total}
      </span>
      <div className="pagination-controls">
        <button
          className="icon-button pagination-button"
          type="button"
          onClick={() => onPageChange(1)}
          disabled={safePage <= 1}
          title="Первая страница"
          aria-label="Первая страница"
        >
          <ChevronsLeft size={17} />
        </button>
        <button
          className="icon-button pagination-button"
          type="button"
          onClick={() => onPageChange(safePage - 1)}
          disabled={safePage <= 1}
          title="Предыдущая страница"
          aria-label="Предыдущая страница"
        >
          <ChevronLeft size={17} />
        </button>
        <span className="pagination-page">
          Страница {safePage} из {totalPages}
        </span>
        <button
          className="icon-button pagination-button"
          type="button"
          onClick={() => onPageChange(safePage + 1)}
          disabled={safePage >= totalPages}
          title="Следующая страница"
          aria-label="Следующая страница"
        >
          <ChevronRight size={17} />
        </button>
        <button
          className="icon-button pagination-button"
          type="button"
          onClick={() => onPageChange(totalPages)}
          disabled={safePage >= totalPages}
          title="Последняя страница"
          aria-label="Последняя страница"
        >
          <ChevronsRight size={17} />
        </button>
      </div>
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-head">
          <span className="section-title">{title}</span>
          <button className="icon-button" type="button" onClick={onClose} title="Закрыть">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// Показывает счётчик и селектбокс версий из истории манифеста/промпта. При
// выборе версии её содержимое открывается в модальном окне поверх формы.
function HistoryControl({
  token,
  listPath,
  entryPath,
  renderEntry,
  modalTitle,
  refreshKey,
}: {
  token: string;
  listPath: string;
  entryPath: (historyId: string) => string;
  renderEntry: (entry: ApiRecord) => string;
  modalTitle: (entry: ApiRecord) => string;
  refreshKey: number;
}) {
  const [versions, setVersions] = useState<ApiRecord[]>([]);
  const [entry, setEntry] = useState<ApiRecord | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<{ items: ApiRecord[] }>(token, listPath)
      .then((data) => setVersions(data.items))
      .catch(() => setVersions([]));
  }, [token, listPath, refreshKey]);

  function openVersion(historyId: string): void {
    if (!historyId) return;
    apiFetch<ApiRecord>(token, entryPath(historyId))
      .then((data) => {
        setEntry(data);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить версию'));
  }

  if (versions.length === 0) return null;

  return (
    <div className="history-control">
      <span className="history-count">
        <InlineIcon icon={History} />
        Версий в истории: {versions.length}
      </span>
      <select value="" onChange={(event) => openVersion(event.target.value)} title="Прошлые версии">
        <option value="">Прошлые версии…</option>
        {versions.map((version) => (
          <option key={field(version, 'id')} value={field(version, 'id')}>
            {formatDate(field(version, 'version_created_at'))}
          </option>
        ))}
      </select>
      <ErrorLine message={error} />
      {entry && (
        <Modal title={modalTitle(entry)} onClose={() => setEntry(null)}>
          <pre className="json-box">{renderEntry(entry)}</pre>
        </Modal>
      )}
    </div>
  );
}

function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('adminToken'));
  const [admin, setAdmin] = useState<AdminSession | null>(null);
  const [route, navigate] = useHashRoute(VIEW_KEYS, DEFAULT_VIEW);
  const view = route.view as ViewKey;
  // Счётчик свежих ошибок исполнения схем для подсветки пункта меню (issue #255).
  const [schemaErrorCount, setSchemaErrorCount] = useState(0);

  useEffect(() => {
    if (!token) return;
    apiFetch<AdminSession>(token, '/api/auth/me')
      .then(setAdmin)
      .catch(() => {
        localStorage.removeItem('adminToken');
        setToken(null);
        setAdmin(null);
      });
  }, [token]);

  // Периодически и при смене раздела обновляем число свежих ошибок схем, чтобы
  // оператор замечал отсутствие активной схемы и падения узлов (этап F).
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const load = () => {
      apiFetch<{ recent: number; total: number }>(token, '/api/schema-executions/error-summary')
        .then((data) => {
          if (!cancelled) setSchemaErrorCount(data.recent ?? 0);
        })
        .catch(() => {
          /* счётчик необязателен — молча игнорируем сбой */
        });
    };
    load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [token, view]);

  function handleAuth(nextToken: string, nextAdmin: AdminSession): void {
    localStorage.setItem('adminToken', nextToken);
    setToken(nextToken);
    setAdmin(nextAdmin);
  }

  function logout(): void {
    localStorage.removeItem('adminToken');
    setToken(null);
    setAdmin(null);
  }

  // Переход в раздел без сущности и фильтров — нажатие на пункт меню.
  function selectView(next: ViewKey): void {
    navigate({ view: next, entityId: null, query: {} });
  }

  // Выбор сущности внутри текущего раздела (клик по строке списка).
  function selectEntity(entityId: string | null): void {
    navigate({ view: route.view, entityId, query: route.query });
  }

  // Применение фильтров текущего раздела. Сбрасывает выбранную сущность,
  // так как после смены фильтра она может выпасть из списка.
  function applyQuery(query: RouteQuery): void {
    navigate({ view: route.view, entityId: null, query });
  }

  // Навигация редактора схем (issue #234): схема привязана к игре, поэтому в URL
  // одновременно кодируются и тип схемы (entityId), и выбранная игра (query.gameId).
  // Так закладка/ссылка воспроизводит конкретную схему конкретной игры.
  function selectSchema(entityId: string | null, gameId: string | null): void {
    navigate({ view: 'schemas', entityId, query: gameId ? { gameId } : {} });
  }

  // Переход из журнала схем в редактор схем (issue #288): открывает схему по slug/gameId
  // и при наличии nodeId центрирует canvas на этом узле.
  function openSchemaEditor(schemaSlug: string, gameId: string | null, nodeId: string | null): void {
    const query: Record<string, string> = {};
    if (gameId) query.gameId = gameId;
    if (nodeId) query.nodeId = nodeId;
    navigate({ view: 'schemas', entityId: schemaSlug, query });
  }

  function openSessionsForUser(userId: string): void {
    navigate({ view: 'sessions', entityId: null, query: { userId } });
  }

  function openSessionsForGame(gameId: string): void {
    navigate({ view: 'sessions', entityId: null, query: { gameId } });
  }

  function openLlmForSession(sessionId: string): void {
    navigate({ view: 'llm', entityId: null, query: { sessionId } });
  }

  function openLlmForUser(userId: string): void {
    navigate({ view: 'llm', entityId: null, query: { userId } });
  }

  if (!token || !admin) {
    return <LoginView onAuth={handleAuth} />;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <ShieldCheck size={18} />
          <span>tg-games admin</span>
        </div>
        <nav className="nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            const showErrorBadge = item.key === 'schema-log' && schemaErrorCount > 0;
            return (
              <button
                className={view === item.key ? 'nav-button active' : 'nav-button'}
                key={item.key}
                type="button"
                onClick={() => selectView(item.key)}
                title={
                  showErrorBadge
                    ? `${item.label}: свежих ошибок исполнения — ${schemaErrorCount}`
                    : item.label
                }
              >
                <Icon size={16} />
                <span>{item.label}</span>
                {showErrorBadge && (
                  <span className="nav-badge" title={`Свежих ошибок: ${schemaErrorCount}`}>
                    {schemaErrorCount > 99 ? '99+' : schemaErrorCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="admin-chip" title={admin.telegramId}>
          {admin.username ? `@${admin.username}` : `id ${admin.telegramId}`}
        </div>
        <button className="icon-button" type="button" onClick={logout} title="Выйти">
          <LogOut size={17} />
        </button>
      </header>
      <main className="workspace">
        {view === 'users' && (
          <UsersView
            token={token}
            entityId={route.entityId}
            query={route.query}
            onSelect={selectEntity}
            onQuery={applyQuery}
            onOpenSessions={openSessionsForUser}
            onOpenLlm={openLlmForUser}
          />
        )}
        {view === 'sessions' && (
          <SessionsView
            token={token}
            entityId={route.entityId}
            query={route.query}
            onSelect={selectEntity}
            onQuery={applyQuery}
            onOpenLlm={openLlmForSession}
          />
        )}
        {view === 'games' && (
          <GamesView
            token={token}
            entityId={route.entityId}
            onSelect={selectEntity}
            onOpenSessions={openSessionsForGame}
          />
        )}
        {view === 'groups' && <GroupsView token={token} entityId={route.entityId} onSelect={selectEntity} />}
        {view === 'schemas' && (
          <SchemasView
            token={token}
            entityId={route.entityId}
            gameId={route.query.gameId ?? null}
            onNavigate={selectSchema}
            focusNodeId={route.query.nodeId ?? null}
          />
        )}
        {view === 'schema-log' && (
          <SchemaExecutionsView
            token={token}
            entityId={route.entityId}
            query={route.query}
            onSelect={selectEntity}
            onQuery={applyQuery}
            onOpenSchema={openSchemaEditor}
          />
        )}
        {view === 'models' && <ModelDefaultsView token={token} />}
        {view === 'topics' && (
          <TopicsView
            token={token}
            entityId={route.entityId}
            query={route.query}
            onSelect={selectEntity}
            onQuery={applyQuery}
          />
        )}
        {view === 'expertise' && <ExpertiseView token={token} entityId={route.entityId} onSelect={selectEntity} />}
        {view === 'ontology' && <OntologyView token={token} />}
        {view === 'llm' && (
          <LlmRequestsView
            token={token}
            entityId={route.entityId}
            query={route.query}
            onSelect={selectEntity}
            onQuery={applyQuery}
          />
        )}
        {view === 'azure' && <AzureModelsView token={token} entityId={route.entityId} onSelect={selectEntity} />}
      </main>
    </div>
  );
}

function LoginView({ onAuth }: { onAuth: (token: string, admin: AdminSession) => void }) {
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function requestCode(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const result = await apiFetch<{ expiresInSeconds: number }>(null, '/api/auth/request-code', {
        method: 'POST',
        body: JSON.stringify({ username }),
      });
      setCodeSent(true);
      setMessage(`Код отправлен в Telegram. Действует ${Math.round(result.expiresInSeconds / 60)} мин.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Не удалось отправить код');
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const result = await apiFetch<{ token: string; admin: AdminSession }>(null, '/api/auth/verify-code', {
        method: 'POST',
        body: JSON.stringify({ username, code }),
      });
      onAuth(result.token, result.admin);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Не удалось войти');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-panel" onSubmit={codeSent ? verifyCode : requestCode}>
        <div className="login-title">
          <ShieldCheck size={24} />
          <span>tg-games admin</span>
        </div>
        <label>
          Имя в Telegram администратора
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="@name"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        {codeSent && (
          <label>
            Код из админского бота
            <input value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" maxLength={6} />
          </label>
        )}
        <ToolbarButton icon={codeSent ? ShieldCheck : KeyRound} type="submit" disabled={busy}>
          {codeSent ? 'Войти' : 'Получить код'}
        </ToolbarButton>
        <ErrorLine message={message} />
      </form>
    </div>
  );
}

function UsersView({
  token,
  entityId,
  query,
  onSelect,
  onQuery,
  onOpenSessions,
  onOpenLlm,
}: {
  token: string;
  entityId: string | null;
  query: RouteQuery;
  onSelect: (id: string | null) => void;
  onQuery: (query: RouteQuery) => void;
  onOpenSessions: (userId: string) => void;
  onOpenLlm: (userId: string) => void;
}) {
  const committedSearch = query.q ?? '';
  const [search, setSearch] = useState(committedSearch);
  const [page, setPage] = useState(1);
  const [users, setUsers] = useState<ApiRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<ApiRecord | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

  // Поле ввода и страница синхронизируются с URL (внешняя навигация, «Назад»).
  useEffect(() => {
    setSearch(committedSearch);
    setPage(1);
  }, [committedSearch]);

  useEffect(() => {
    const params = buildPagedSearchParams({ search: committedSearch || undefined }, page);
    apiFetch<ListResponse<ApiRecord>>(token, `/api/users?${params}`)
      .then((data) => {
        setUsers(data.items);
        setTotal(data.total ?? data.items.length);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить пользователей'));
  }, [token, committedSearch, refresh, page]);

  useEffect(() => {
    const pages = pageCount(total);
    if (page > pages) setPage(pages);
  }, [page, total]);

  useEffect(() => {
    if (!entityId) {
      setSelected(null);
      return;
    }
    apiFetch<ApiRecord>(token, `/api/users/${entityId}`)
      .then(setSelected)
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить пользователя'));
  }, [token, entityId]);

  return (
    <section className="view-grid">
      <div className="panel list-panel">
        <form
          className="toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            onQuery(search.trim() ? { q: search.trim() } : {});
          }}
        >
          <input placeholder="Поиск по username или telegram id" value={search} onChange={(event) => setSearch(event.target.value)} />
          <ToolbarButton icon={Search} type="submit">Искать</ToolbarButton>
          <ToolbarButton icon={RefreshCw} onClick={() => setRefresh((value) => value + 1)}>Обновить</ToolbarButton>
        </form>
        <div className="section-title">Пользователи · {total}</div>
        <ErrorLine message={error} />
        <table>
          <thead>
            <tr>
              <th>Пользователь</th>
              <th>Telegram ID</th>
              <th>Сессии</th>
              <th>Регистрация</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={field(user, 'id')} onClick={() => onSelect(field(user, 'id'))}>
                <td>{field(user, 'username') ? `@${field(user, 'username')}` : '—'}</td>
                <td>{field(user, 'telegram_id')}</td>
                <td>{field(user, 'session_count') || '0'}</td>
                <td>{formatDate(field(user, 'created_at'))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination page={page} total={total} onPageChange={setPage} />
      </div>
      <aside className="panel detail-panel">
        {!selected && <EmptyState>Выберите пользователя.</EmptyState>}
        {selected && (
          <>
            <div className="section-title">{field(selected, 'username') ? `@${field(selected, 'username')}` : `id ${field(selected, 'telegram_id')}`}</div>
            <dl className="meta-list">
              <dt>ID</dt>
              <dd>{field(selected, 'id')}</dd>
              <dt>Дата регистрации</dt>
              <dd>{formatDate(field(selected, 'created_at'))}</dd>
              <dt>Игровых сессий</dt>
              <dd>{field(selected, 'session_count') || '0'}</dd>
              <dt>Группы</dt>
              <dd>{fieldArray(selected, 'groups').join(', ') || '—'}</dd>
              <dt>Доступные игры</dt>
              <dd>{fieldArray(selected, 'game_ids').join(', ') || '—'}</dd>
            </dl>
            <div className="button-row">
              <ToolbarButton icon={ListChecks} onClick={() => onOpenSessions(field(selected, 'id'))}>
                Сессии пользователя
              </ToolbarButton>
              <ToolbarButton icon={Cpu} onClick={() => onOpenLlm(field(selected, 'id'))}>
                LLM запросы
              </ToolbarButton>
            </div>
          </>
        )}
      </aside>
    </section>
  );
}

function SessionsView({
  token,
  entityId,
  query,
  onSelect,
  onQuery,
  onOpenLlm,
}: {
  token: string;
  entityId: string | null;
  query: RouteQuery;
  onSelect: (id: string | null) => void;
  onQuery: (query: RouteQuery) => void;
  onOpenLlm: (sessionId: string) => void;
}) {
  const committed = {
    userId: query.userId ?? '',
    gameId: query.gameId ?? '',
    telegramId: query.telegramId ?? '',
    status: query.status ?? '',
  };
  const [filters, setFilters] = useState(committed);
  const [page, setPage] = useState(1);
  const [sessions, setSessions] = useState<ApiRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<ApiRecord | null>(null);
  const [error, setError] = useState('');

  // Поля фильтра и страница синхронизируются с URL (внешняя навигация, «Назад»).
  useEffect(() => {
    setFilters({
      userId: query.userId ?? '',
      gameId: query.gameId ?? '',
      telegramId: query.telegramId ?? '',
      status: query.status ?? '',
    });
    setPage(1);
  }, [query.userId, query.gameId, query.telegramId, query.status]);

  useEffect(() => {
    const params = buildPagedSearchParams(committed, page);
    apiFetch<ListResponse<ApiRecord>>(token, `/api/sessions?${params}`)
      .then((data) => {
        setSessions(data.items);
        setTotal(data.total ?? data.items.length);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить сессии'));
  }, [token, committed.userId, committed.gameId, committed.telegramId, committed.status, page]);

  useEffect(() => {
    const pages = pageCount(total);
    if (page > pages) setPage(pages);
  }, [page, total]);

  useEffect(() => {
    if (!entityId) {
      setSelected(null);
      return;
    }
    apiFetch<ApiRecord>(token, `/api/sessions/${entityId}`)
      .then(setSelected)
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить сессию'));
  }, [token, entityId]);

  const steps = useMemo(() => {
    const value = selected?.steps;
    return Array.isArray(value) ? (value as ApiRecord[]) : [];
  }, [selected]);

  return (
    <section className="view-grid wide-detail">
      <div className="panel list-panel">
        <form
          className="toolbar filters"
          onSubmit={(event) => {
            event.preventDefault();
            onQuery({ ...filters });
          }}
        >
          <input placeholder="user_id" value={filters.userId} onChange={(event) => setFilters({ ...filters, userId: event.target.value })} />
          <input placeholder="telegram id" value={filters.telegramId} onChange={(event) => setFilters({ ...filters, telegramId: event.target.value })} />
          <input placeholder="game_id" value={filters.gameId} onChange={(event) => setFilters({ ...filters, gameId: event.target.value })} />
          <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
            <option value="">любой статус</option>
            <option value="active">активна</option>
            <option value="finished">завершена</option>
            <option value="processing">обработка</option>
          </select>
          <ToolbarButton icon={Search} type="submit">Фильтр</ToolbarButton>
        </form>
        <div className="section-title">Сессии · {total}</div>
        <ErrorLine message={error} />
        <table>
          <thead>
            <tr>
              <th>Сессия</th>
              <th>Игра</th>
              <th>Пользователь</th>
              <th>Статус</th>
              <th>Расход</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={field(session, 'id')} onClick={() => onSelect(field(session, 'id'))}>
                <td>{shortId(field(session, 'id'))}</td>
                <td>{field(session, 'game_name') || field(session, 'game_id')}</td>
                <td>{field(session, 'user_username') ? `@${field(session, 'user_username')}` : field(session, 'user_telegram_id')}</td>
                <td><span className="badge">{statusLabel(session)}</span></td>
                <td>{moneyMillicents(field(session, 'cost_millicents'))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination page={page} total={total} onPageChange={setPage} />
      </div>
      <aside className="panel detail-panel">
        {!selected && <EmptyState>Выберите сессию.</EmptyState>}
        {selected && (
          <>
            <div className="section-title">{field(selected, 'game_name') || field(selected, 'game_id')}</div>
            <dl className="meta-list">
              <dt>ID</dt>
              <dd>{field(selected, 'id')}</dd>
              <dt>Пользователь</dt>
              <dd>{field(selected, 'user_username') ? `@${field(selected, 'user_username')}` : field(selected, 'user_telegram_id')}</dd>
              <dt>Статус</dt>
              <dd>{statusLabel(selected)}</dd>
              <dt>Баланс</dt>
              <dd>{moneyMillicents(field(selected, 'balance_millicents'))}</dd>
              <dt>Расход</dt>
              <dd>{moneyMillicents(field(selected, 'cost_millicents'))}</dd>
            </dl>
            <div className="button-row">
              <ToolbarButton icon={Cpu} onClick={() => onOpenLlm(field(selected, 'id'))}>
                LLM запросы сессии
              </ToolbarButton>
            </div>
            <div className="subhead">Состояние</div>
            <pre className="json-box">{jsonPreview(selected.current_state)}</pre>
            <div className="subhead">Лог действий</div>
            <div className="timeline">
              {steps.map((step) => (
                <div className="timeline-item" key={field(step, 'id')}>
                  <div className="timeline-meta">{formatDate(field(step, 'created_at'))} · {moneyMillicents(field(step, 'cost_millicents'))}</div>
                  <div className="timeline-action">{field(step, 'action_text') || 'старт'}</div>
                  <div>{field(step, 'changes_summary') || '—'}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </aside>
    </section>
  );
}

function GamesView({
  token,
  entityId,
  onSelect,
  onOpenSessions,
}: {
  token: string;
  entityId: string | null;
  onSelect: (id: string | null) => void;
  onOpenSessions: (gameId: string) => void;
}) {
  const [games, setGames] = useState<ApiRecord[]>([]);
  const selectedId = entityId;
  const [selected, setSelected] = useState<ApiRecord | null>(null);
  const [manifestText, setManifestText] = useState('');
  const [groupsText, setGroupsText] = useState('');
  const [newManifest, setNewManifest] = useState('{\n  "id": "new_game",\n  "name": "Новая игра"\n}');
  const [newGroups, setNewGroups] = useState('default');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiFetch<ListResponse<ApiRecord>>(token, '/api/games?limit=100&offset=0')
      .then((data) => {
        setGames(data.items);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить игры'));
  }, [token, refresh]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    apiFetch<ApiRecord>(token, `/api/games/${selectedId}`)
      .then((game) => {
        setSelected(game);
        setManifestText(jsonPreview(game.manifest));
        const groups = Array.isArray(game.groups) ? game.groups.map((group) => field(group as ApiRecord, 'group_id')) : [];
        setGroupsText(groups.join(', '));
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить игру'));
  }, [token, selectedId, refresh]);

  async function saveManifest(): Promise<void> {
    if (!selectedId) return;
    try {
      await apiFetch(token, `/api/games/${selectedId}/manifest`, {
        method: 'PATCH',
        body: JSON.stringify(JSON.parse(manifestText) as ApiRecord),
      });
      setRefresh((value) => value + 1);
    } catch (err) {
      setNotice('');
      setError(err instanceof Error ? err.message : 'Не удалось сохранить манифест');
    }
  }

  async function saveGroups(): Promise<void> {
    if (!selectedId) return;
    try {
      await apiFetch(token, `/api/games/${selectedId}/groups`, {
        method: 'PATCH',
        body: JSON.stringify({ groupIds: splitIds(groupsText) }),
      });
      setRefresh((value) => value + 1);
    } catch (err) {
      setNotice('');
      setError(err instanceof Error ? err.message : 'Не удалось сохранить группы');
    }
  }

  async function createGame(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      const created = await apiFetch<ApiRecord>(token, '/api/games', {
        method: 'POST',
        body: JSON.stringify({
          manifest: JSON.parse(newManifest) as ApiRecord,
          groupIds: splitIds(newGroups),
        }),
      });
      onSelect(field(created, 'game_id'));
      setRefresh((value) => value + 1);
    } catch (err) {
      setNotice('');
      setError(err instanceof Error ? err.message : 'Не удалось добавить игру');
    }
  }

  async function exportManifests(): Promise<void> {
    try {
      const data = await apiFetch<ApiRecord>(token, '/api/games/export');
      downloadJsonFile(`tg-games-manifests-${fileTimestamp()}.json`, data);
      setError('');
      setNotice('JSON-файл манифестов подготовлен.');
    } catch (err) {
      setNotice('');
      setError(err instanceof Error ? err.message : 'Не удалось экспортировать манифесты');
    }
  }

  async function importManifests(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text()) as unknown;
      const result = await apiFetch<ImportSummary>(token, '/api/games/import', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setError('');
      setNotice(importSummaryText(result));
      setRefresh((value) => value + 1);
    } catch (err) {
      setNotice('');
      setError(
        err instanceof SyntaxError
          ? 'Не удалось прочитать JSON-файл'
          : err instanceof Error
            ? err.message
            : 'Не удалось импортировать манифесты',
      );
    }
  }

  return (
    <section className="view-grid wide-detail">
      <div className="panel list-panel">
        <div className="toolbar">
          <ToolbarButton icon={RefreshCw} onClick={() => setRefresh((value) => value + 1)}>Обновить</ToolbarButton>
          <ToolbarButton icon={Download} onClick={exportManifests}>Экспорт</ToolbarButton>
          <ToolbarButton icon={Upload} onClick={() => importInputRef.current?.click()}>Импорт</ToolbarButton>
          <input
            ref={importInputRef}
            className="file-input"
            type="file"
            accept="application/json,.json"
            onChange={importManifests}
          />
        </div>
        <div className="section-title">Игры</div>
        <ErrorLine message={error} />
        <MessageLine message={notice} />
        <table>
          <thead>
            <tr>
              <th>Название</th>
              <th>ID</th>
            </tr>
          </thead>
          <tbody>
            {games.map((game) => (
              <tr key={field(game, 'game_id')} onClick={() => onSelect(field(game, 'game_id'))}>
                <td>{field(game, 'name')}</td>
                <td>{field(game, 'game_id')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <form className="create-box" onSubmit={createGame}>
          <div className="subhead">Добавить сценарий</div>
          <textarea value={newManifest} onChange={(event) => setNewManifest(event.target.value)} rows={9} spellCheck={false} />
          <input value={newGroups} onChange={(event) => setNewGroups(event.target.value)} placeholder="group_id через запятую" />
          <ToolbarButton icon={Plus} type="submit">Добавить</ToolbarButton>
        </form>
      </div>
      <aside className="panel detail-panel">
        {!selected && <EmptyState>Выберите игру.</EmptyState>}
        {selected && (
          <>
            <div className="section-title">{field(selected.manifest as ApiRecord, 'name') || field(selected, 'game_id')}</div>
            <dl className="meta-list">
              <dt>ID</dt>
              <dd>{field(selected, 'game_id')}</dd>
              <dt>Сессий</dt>
              <dd>{field(selected, 'session_count') || '0'}</dd>
              <dt>Группы</dt>
              <dd>{groupsText || '—'}</dd>
            </dl>
            <div className="button-row">
              <ToolbarButton icon={ListChecks} onClick={() => onOpenSessions(field(selected, 'game_id'))}>Сессии игры</ToolbarButton>
            </div>
            <div className="editor-label">
              <div className="editor-head">
                <span>Манифест</span>
                <HistoryControl
                  token={token}
                  listPath={`/api/games/${field(selected, 'game_id')}/manifest-history`}
                  entryPath={(historyId) => `/api/games/${field(selected, 'game_id')}/manifest-history/${historyId}`}
                  renderEntry={(entry) => jsonPreview(entry.manifest)}
                  modalTitle={(entry) => `Манифест от ${formatDate(field(entry, 'version_created_at'))}`}
                  refreshKey={refresh}
                />
              </div>
              <textarea value={manifestText} onChange={(event) => setManifestText(event.target.value)} rows={16} spellCheck={false} />
            </div>
            <ToolbarButton icon={Save} onClick={saveManifest}>Сохранить манифест</ToolbarButton>
            <label className="editor-label compact">
              Группы игры
              <input value={groupsText} onChange={(event) => setGroupsText(event.target.value)} />
            </label>
            <ToolbarButton icon={Save} onClick={saveGroups}>Сохранить группы</ToolbarButton>
          </>
        )}
      </aside>
    </section>
  );
}

function GroupsView({
  token,
  entityId,
  onSelect,
}: {
  token: string;
  entityId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [groups, setGroups] = useState<ApiRecord[]>([]);
  const selectedId = entityId;
  const [selected, setSelected] = useState<ApiRecord | null>(null);
  const [gameIds, setGameIds] = useState('');
  const [newGroupId, setNewGroupId] = useState('');
  const [newGroupGames, setNewGroupGames] = useState('');
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    apiFetch<{ items: ApiRecord[] }>(token, '/api/groups')
      .then((data) => {
        setGroups(data.items);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить группы'));
  }, [token, refresh]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    apiFetch<ApiRecord>(token, `/api/groups/${selectedId}`)
      .then((group) => {
        setSelected(group);
        setGameIds(fieldArray(group, 'game_ids').join(', '));
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить группу'));
  }, [token, selectedId, refresh]);

  async function saveGroup(): Promise<void> {
    if (!selectedId) return;
    try {
      await apiFetch(token, `/api/groups/${selectedId}`, {
        method: 'PATCH',
        body: JSON.stringify({ gameIds: splitIds(gameIds) }),
      });
      setRefresh((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить группу');
    }
  }

  async function createGroup(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      await apiFetch(token, '/api/groups', {
        method: 'POST',
        body: JSON.stringify({ groupId: newGroupId, gameIds: splitIds(newGroupGames) }),
      });
      onSelect(newGroupId);
      setNewGroupId('');
      setNewGroupGames('');
      setRefresh((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать группу');
    }
  }

  const users = Array.isArray(selected?.users) ? (selected.users as ApiRecord[]) : [];
  const games = Array.isArray(selected?.games) ? (selected.games as ApiRecord[]) : [];

  return (
    <section className="view-grid">
      <div className="panel list-panel">
        <div className="section-title">Группы</div>
        <ErrorLine message={error} />
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Игры</th>
              <th>Игроки</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <tr key={field(group, 'group_id')} onClick={() => onSelect(field(group, 'group_id'))}>
                <td>{field(group, 'group_id')}</td>
                <td>{fieldArray(group, 'game_ids').length}</td>
                <td>{field(group, 'user_count') || '0'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <form className="create-box" onSubmit={createGroup}>
          <div className="subhead">Новая группа</div>
          <input value={newGroupId} onChange={(event) => setNewGroupId(event.target.value)} placeholder="group_id" />
          <input value={newGroupGames} onChange={(event) => setNewGroupGames(event.target.value)} placeholder="game_id через запятую" />
          <ToolbarButton icon={Plus} type="submit">Создать</ToolbarButton>
        </form>
      </div>
      <aside className="panel detail-panel">
        {!selected && <EmptyState>Выберите группу.</EmptyState>}
        {selected && (
          <>
            <div className="section-title">{field(selected, 'group_id')}</div>
            <label className="editor-label compact">
              Игры группы
              <input value={gameIds} onChange={(event) => setGameIds(event.target.value)} />
            </label>
            <ToolbarButton icon={Save} onClick={saveGroup}>Сохранить игры</ToolbarButton>
            <div className="subhead">Игры</div>
            <ul className="plain-list">
              {games.map((game) => <li key={field(game, 'game_id')}>{field(game, 'name')} · {field(game, 'game_id')}</li>)}
            </ul>
            <div className="subhead">Игроки · {field(selected, 'user_count') || users.length}</div>
            <ul className="plain-list">
              {users.map((user) => <li key={field(user, 'id')}>{field(user, 'username') ? `@${field(user, 'username')}` : field(user, 'telegram_id')}</li>)}
            </ul>
          </>
        )}
      </aside>
    </section>
  );
}

function ModelDefaultsView({ token }: { token: string }) {
  const [defaults, setDefaults] = useState<ApiRecord | null>(null);
  const [llmModel, setLlmModel] = useState('');
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [refresh, setRefresh] = useState(0);

  const llm = recordField(defaults, 'llm');
  const embedding = recordField(defaults, 'embedding');

  useEffect(() => {
    apiFetch<ApiRecord>(token, '/api/model-defaults')
      .then((data) => {
        setDefaults(data);
        setLlmModel(field(recordField(data, 'llm'), 'model'));
        setEmbeddingModel(field(recordField(data, 'embedding'), 'model'));
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить модели'));
  }, [token, refresh]);

  async function saveDefaults(): Promise<void> {
    setSaving(true);
    setNotice('');
    try {
      const data = await apiFetch<ApiRecord>(token, '/api/model-defaults', {
        method: 'PATCH',
        body: JSON.stringify({
          llmModelName: llmModel.trim(),
          embeddingModel: embeddingModel.trim(),
        }),
      });
      setDefaults(data);
      setLlmModel(field(recordField(data, 'llm'), 'model'));
      setEmbeddingModel(field(recordField(data, 'embedding'), 'model'));
      setNotice('Модели сохранены');
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить модели');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="view-grid">
      <div className="panel list-panel">
        <div className="toolbar">
          <ToolbarButton icon={RefreshCw} onClick={() => setRefresh((value) => value + 1)}>Обновить</ToolbarButton>
        </div>
        <div className="section-title">Глобальные модели</div>
        <ErrorLine message={error} />
        <MessageLine message={notice} />

        <div className="subhead">LLM</div>
        <dl className="meta-list">
          <dt>Провайдер</dt>
          <dd><span className="badge">{providerLabel(field(llm, 'provider'))}</span></dd>
          <dt>Сейчас</dt>
          <dd>{field(llm, 'model') || '—'}</dd>
          <dt>Источник</dt>
          <dd>{field(llm, 'source') === 'database' ? 'админка' : '.env'}</dd>
        </dl>
        <label className="editor-label compact">
          Модель LLM по умолчанию
          <input value={llmModel} onChange={(event) => setLlmModel(event.target.value)} />
        </label>

        <div className="subhead">Embeddings</div>
        <dl className="meta-list">
          <dt>Провайдер</dt>
          <dd><span className="badge">{providerLabel(field(embedding, 'provider'))}</span></dd>
          <dt>Сейчас</dt>
          <dd>{field(embedding, 'model') || '—'}</dd>
          <dt>Источник</dt>
          <dd>{field(embedding, 'source') === 'database' ? 'админка' : '.env'}</dd>
        </dl>
        <label className="editor-label compact">
          Модель embeddings по умолчанию
          <input value={embeddingModel} onChange={(event) => setEmbeddingModel(event.target.value)} />
        </label>

        <div className="button-row">
          <ToolbarButton icon={Save} onClick={saveDefaults} disabled={saving}>Сохранить</ToolbarButton>
        </div>
      </div>

      <aside className="panel detail-panel">
        <div className="section-title">Текущие значения</div>
        {!defaults && <EmptyState>Нет данных.</EmptyState>}
        {defaults && (
          <>
            <div className="subhead">LLM</div>
            <dl className="meta-list">
              <dt>Провайдер</dt>
              <dd>{providerLabel(field(llm, 'provider'))}</dd>
              <dt>Модель</dt>
              <dd>{field(llm, 'model') || '—'}</dd>
              <dt>.env</dt>
              <dd>{field(llm, 'envModel') || '—'}</dd>
              <dt>Обновлено</dt>
              <dd>{formatDate(field(llm, 'updatedAt') || undefined)}</dd>
            </dl>

            <div className="subhead">Embeddings</div>
            <dl className="meta-list">
              <dt>Провайдер</dt>
              <dd>{providerLabel(field(embedding, 'provider'))}</dd>
              <dt>Модель</dt>
              <dd>{field(embedding, 'model') || '—'}</dd>
              <dt>.env</dt>
              <dd>{field(embedding, 'envModel') || '—'}</dd>
              <dt>Обновлено</dt>
              <dd>{formatDate(field(embedding, 'updatedAt') || undefined)}</dd>
            </dl>
          </>
        )}
      </aside>
    </section>
  );
}

function TopicsView({
  token,
  entityId,
  query,
  onSelect,
  onQuery,
}: {
  token: string;
  entityId: string | null;
  query: RouteQuery;
  onSelect: (id: string | null) => void;
  onQuery: (query: RouteQuery) => void;
}) {
  const status = query.status ?? '';
  const selectedId = entityId;
  const [topics, setTopics] = useState<ApiRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<ApiRecord | null>(null);
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams({ limit: '50', offset: '0' });
    if (status) params.set('status', status);
    apiFetch<ListResponse<ApiRecord>>(token, `/api/topics?${params}`)
      .then((data) => {
        setTopics(data.items);
        setTotal(data.total ?? data.items.length);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить обращения'));
  }, [token, status]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    apiFetch<ApiRecord>(token, `/api/topics/${selectedId}`)
      .then(setSelected)
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить обращение'));
  }, [token, selectedId]);

  function handleCloseTopic() {
    if (!selectedId) return;
    setClosing(true);
    apiFetch<ApiRecord>(token, `/api/topics/${selectedId}/close`, { method: 'POST' })
      .then((updated) => {
        setSelected((prev) => (prev ? { ...prev, status: updated.status ?? 'closed' } : prev));
        setTopics((prev) =>
          prev.map((t) => (field(t, 'id') === selectedId ? { ...t, status: updated.status ?? 'closed' } : t)),
        );
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось закрыть обращение'))
      .finally(() => setClosing(false));
  }

  const messages = Array.isArray(selected?.messages) ? (selected.messages as ApiRecord[]) : [];
  const isOpen = field(selected, 'status') === 'open';

  return (
    <section className="view-grid">
      <div className="panel list-panel">
        <div className="toolbar">
          <select value={status} onChange={(event) => onQuery(event.target.value ? { status: event.target.value } : {})}>
            <option value="">любой статус</option>
            <option value="open">открытые</option>
            <option value="closed">закрытые</option>
            <option value="auto_closed">закрытые автоматически</option>
          </select>
        </div>
        <div className="section-title">Топики · {total}</div>
        <ErrorLine message={error} />
        <table>
          <thead>
            <tr>
              <th>Номер</th>
              <th>Пользователь</th>
              <th>Статус</th>
              <th>Последнее</th>
            </tr>
          </thead>
          <tbody>
            {topics.map((topic) => (
              <tr key={field(topic, 'id')} onClick={() => onSelect(field(topic, 'id'))}>
                <td>#{field(topic, 'number')}</td>
                <td>{field(topic, 'user_username') ? `@${field(topic, 'user_username')}` : field(topic, 'user_telegram_id')}</td>
                <td><span className="badge">{field(topic, 'status')}</span></td>
                <td>{formatDate(field(topic, 'last_message_at'))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <aside className="panel detail-panel">
        {!selected && <EmptyState>Выберите топик.</EmptyState>}
        {selected && (
          <>
            <div className="section-title">Обращение #{field(selected, 'number')}</div>
            <dl className="meta-list">
              <dt>Пользователь</dt>
              <dd>{field(selected, 'user_username') ? `@${field(selected, 'user_username')}` : field(selected, 'user_telegram_id')}</dd>
              <dt>Статус</dt>
              <dd>{field(selected, 'status')}</dd>
              <dt>Создан</dt>
              <dd>{formatDate(field(selected, 'created_at'))}</dd>
            </dl>
            <div className="timeline">
              {messages.map((message) => (
                <div className="timeline-item" key={field(message, 'id')}>
                  <div className="timeline-meta">{field(message, 'sender')} · {formatDate(field(message, 'created_at'))}</div>
                  <div>{field(message, 'text')}</div>
                </div>
              ))}
            </div>
            {isOpen && (
              <div className="toolbar" style={{ marginTop: '0.75rem' }}>
                <ToolbarButton icon={X} onClick={handleCloseTopic} disabled={closing}>
                  {closing ? 'Закрытие…' : 'Закрыть обращение'}
                </ToolbarButton>
              </div>
            )}
          </>
        )}
      </aside>
    </section>
  );
}

function tokenUsageSummary(value: unknown): string {
  if (!value || typeof value !== 'object') return '—';
  const usage = value as Record<string, unknown>;
  const input = Number(usage.inputTokens ?? 0);
  const output = Number(usage.outputTokens ?? 0);
  return `вход ${input} · выход ${output}`;
}

// Журнал исполнения схем (issue #255, этап F). Оператор фильтрует записи по типу
// схемы, игре и статусу и в деталях видит причину сбоя (узел, тип узла, текст и
// сырой ответ LLM) без доступа к серверным логам.
function SchemaExecutionsView({
  token,
  entityId,
  query,
  onSelect,
  onQuery,
  onOpenSchema,
}: {
  token: string;
  entityId: string | null;
  query: RouteQuery;
  onSelect: (id: string | null) => void;
  onQuery: (query: RouteQuery) => void;
  // Переход в редактор схем (issue #288): открывает схему, опционально центрирует на узле.
  onOpenSchema?: (schemaSlug: string, gameId: string | null, nodeId: string | null) => void;
}) {
  const committed = {
    schemaType: query.schemaType ?? '',
    gameId: query.gameId ?? '',
    schemaSlug: query.schemaSlug ?? '',
    status: query.status ?? '',
    sessionId: query.sessionId ?? '',
  };
  const [filters, setFilters] = useState(committed);
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<ApiRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<ApiRecord | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setFilters({
      schemaType: query.schemaType ?? '',
      gameId: query.gameId ?? '',
      schemaSlug: query.schemaSlug ?? '',
      status: query.status ?? '',
      sessionId: query.sessionId ?? '',
    });
    setPage(1);
  }, [query.schemaType, query.gameId, query.schemaSlug, query.status, query.sessionId]);

  useEffect(() => {
    const params = buildPagedSearchParams(committed, page);
    apiFetch<ListResponse<ApiRecord>>(token, `/api/schema-executions?${params}`)
      .then((data) => {
        setItems(data.items);
        setTotal(data.total ?? data.items.length);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить журнал схем'));
  }, [token, committed.schemaType, committed.gameId, committed.schemaSlug, committed.status, committed.sessionId, page]);

  useEffect(() => {
    const pages = pageCount(total);
    if (page > pages) setPage(pages);
  }, [page, total]);

  useEffect(() => {
    if (!entityId) {
      setSelected(null);
      return;
    }
    apiFetch<ApiRecord>(token, `/api/schema-executions/${entityId}`)
      .then(setSelected)
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить запись журнала'));
  }, [token, entityId]);

  return (
    <section className="view-grid wide-detail">
      <div className="panel list-panel">
        <form
          className="toolbar filters"
          onSubmit={(event) => {
            event.preventDefault();
            onQuery({ ...filters });
          }}
        >
          <select value={filters.schemaType} onChange={(event) => setFilters({ ...filters, schemaType: event.target.value })}>
            <option value="">любой тип</option>
            {Object.entries(SCHEMA_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
            <option value="">любой результат</option>
            <option value="ok">успех</option>
            <option value="error">ошибка</option>
          </select>
          <input placeholder="game_id" value={filters.gameId} onChange={(event) => setFilters({ ...filters, gameId: event.target.value })} />
          <input placeholder="schema_slug" value={filters.schemaSlug} onChange={(event) => setFilters({ ...filters, schemaSlug: event.target.value })} />
          <input placeholder="session_id" value={filters.sessionId} onChange={(event) => setFilters({ ...filters, sessionId: event.target.value })} />
          <ToolbarButton icon={Search} type="submit">Фильтр</ToolbarButton>
        </form>
        <div className="section-title">Журнал исполнения схем · {total}</div>
        <ErrorLine message={error} />
        <table>
          <thead>
            <tr>
              <th>Время</th>
              <th>Тип</th>
              <th>Схема</th>
              <th>Узел</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={field(item, 'id')} onClick={() => onSelect(field(item, 'id'))}>
                <td>{formatDate(field(item, 'created_at'))}</td>
                <td>{field(item, 'schema_type') ? schemaTypeLabel(field(item, 'schema_type')) : '—'}</td>
                <td>{field(item, 'schema_slug')}</td>
                <td>{field(item, 'error_node_id') || '—'}</td>
                <td>
                  <span className={item.has_error === true ? 'badge badge-error' : 'badge'}>
                    {item.has_error === true ? 'ошибка' : 'ок'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination page={page} total={total} onPageChange={setPage} />
      </div>
      <aside className="panel detail-panel">
        {!selected && <EmptyState>Выберите запись журнала.</EmptyState>}
        {selected && (
          <>
            <div className="section-title">
              {field(selected, 'schema_type') ? schemaTypeLabel(field(selected, 'schema_type')) : 'Схема'} · {field(selected, 'schema_slug')}
            </div>
            <dl className="meta-list">
              <dt>ID</dt>
              <dd>{field(selected, 'id')}</dd>
              <dt>Время</dt>
              <dd>{formatDate(field(selected, 'created_at'))}</dd>
              <dt>Тип схемы</dt>
              <dd>{field(selected, 'schema_type') ? schemaTypeLabel(field(selected, 'schema_type')) : '—'}</dd>
              <dt>Схема</dt>
              <dd>
                {onOpenSchema && field(selected, 'schema_slug') ? (
                  <button
                    type="button"
                    className="link-button"
                    title="Открыть схему в редакторе"
                    onClick={() => onOpenSchema(field(selected, 'schema_slug'), field(selected, 'game_id') || null, null)}
                  >
                    {field(selected, 'schema_slug')}
                  </button>
                ) : (
                  field(selected, 'schema_slug') || '—'
                )}
              </dd>
              <dt>Игра</dt>
              <dd>{field(selected, 'game_id') || '—'}</dd>
              <dt>Сессия</dt>
              <dd>{field(selected, 'session_id') ? shortId(field(selected, 'session_id')) : '—'}</dd>
              <dt>Длительность</dt>
              <dd>{field(selected, 'duration_ms')} мс</dd>
              <dt>Результат</dt>
              <dd>{selected.has_error === true ? 'ошибка' : 'успех'}</dd>
            </dl>
            {selected.has_error === true && (
              <>
                <div className="subhead">Ошибка исполнения</div>
                <dl className="meta-list">
                  <dt>Узел</dt>
                  <dd>
                    {onOpenSchema && field(selected, 'error_node_id') ? (
                      <button
                        type="button"
                        className="link-button"
                        title="Открыть схему и перейти к узлу"
                        onClick={() =>
                          onOpenSchema(
                            field(selected, 'schema_slug'),
                            field(selected, 'game_id') || null,
                            field(selected, 'error_node_id'),
                          )
                        }
                      >
                        {field(selected, 'error_node_id')}
                      </button>
                    ) : (
                      field(selected, 'error_node_id') || '—'
                    )}
                  </dd>
                  <dt>Тип узла</dt>
                  <dd>{field(selected, 'error_node_type') || '—'}</dd>
                </dl>
                <pre className="json-box error-box">{field(selected, 'error_message') || '—'}</pre>
                {field(selected, 'error_last_raw') && (
                  <>
                    <div className="subhead">Последний сырой ответ LLM</div>
                    <pre className="json-box">{field(selected, 'error_last_raw')}</pre>
                  </>
                )}
              </>
            )}
            <div className="subhead">Входные данные</div>
            <pre className="json-box">{jsonPreview(selected.inputs_json)}</pre>
            <div className="subhead">Выходные данные</div>
            <pre className="json-box">{jsonPreview(selected.outputs_json)}</pre>
            <div className="subhead">LLM-лог</div>
            <pre className="json-box">{jsonPreview(selected.llm_log)}</pre>
          </>
        )}
      </aside>
    </section>
  );
}

function LlmRequestsView({
  token,
  entityId,
  query,
  onSelect,
  onQuery,
}: {
  token: string;
  entityId: string | null;
  query: RouteQuery;
  onSelect: (id: string | null) => void;
  onQuery: (query: RouteQuery) => void;
}) {
  const committed = {
    sessionId: query.sessionId ?? '',
    userId: query.userId ?? '',
    telegramId: query.telegramId ?? '',
    requestKind: query.requestKind ?? '',
    hasError: query.hasError ?? '',
  };
  const [filters, setFilters] = useState(committed);
  const [page, setPage] = useState(1);
  const [requests, setRequests] = useState<ApiRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<ApiRecord | null>(null);
  const [error, setError] = useState('');

  // Поля фильтра и страница синхронизируются с URL (внешняя навигация, «Назад»).
  useEffect(() => {
    setFilters({
      sessionId: query.sessionId ?? '',
      userId: query.userId ?? '',
      telegramId: query.telegramId ?? '',
      requestKind: query.requestKind ?? '',
      hasError: query.hasError ?? '',
    });
    setPage(1);
  }, [query.sessionId, query.userId, query.telegramId, query.requestKind, query.hasError]);

  useEffect(() => {
    const params = buildPagedSearchParams(committed, page);
    apiFetch<ListResponse<ApiRecord>>(token, `/api/llm-requests?${params}`)
      .then((data) => {
        setRequests(data.items);
        setTotal(data.total ?? data.items.length);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить запросы LLM'));
  }, [token, committed.sessionId, committed.userId, committed.telegramId, committed.requestKind, committed.hasError, page]);

  useEffect(() => {
    const pages = pageCount(total);
    if (page > pages) setPage(pages);
  }, [page, total]);

  useEffect(() => {
    if (!entityId) {
      setSelected(null);
      return;
    }
    apiFetch<ApiRecord>(token, `/api/llm-requests/${entityId}`)
      .then(setSelected)
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить запрос LLM'));
  }, [token, entityId]);

  return (
    <section className="view-grid wide-detail">
      <div className="panel list-panel">
        <form
          className="toolbar filters"
          onSubmit={(event) => {
            event.preventDefault();
            onQuery({ ...filters });
          }}
        >
          <input placeholder="session_id" value={filters.sessionId} onChange={(event) => setFilters({ ...filters, sessionId: event.target.value })} />
          <input placeholder="user_id" value={filters.userId} onChange={(event) => setFilters({ ...filters, userId: event.target.value })} />
          <input placeholder="telegram id" value={filters.telegramId} onChange={(event) => setFilters({ ...filters, telegramId: event.target.value })} />
          <select value={filters.requestKind} onChange={(event) => setFilters({ ...filters, requestKind: event.target.value })}>
            <option value="">любой тип</option>
            {Object.entries(LLM_KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <select value={filters.hasError} onChange={(event) => setFilters({ ...filters, hasError: event.target.value })}>
            <option value="">любой результат</option>
            <option value="false">без ошибки</option>
            <option value="true">с ошибкой</option>
          </select>
          <ToolbarButton icon={Search} type="submit">Фильтр</ToolbarButton>
        </form>
        <div className="section-title">LLM запросы · {total}</div>
        <ErrorLine message={error} />
        <table>
          <thead>
            <tr>
              <th>Время</th>
              <th>Тип</th>
              <th>Модель</th>
              <th>Пользователь</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => (
              <tr key={field(request, 'id')} onClick={() => onSelect(field(request, 'id'))}>
                <td>{formatDate(field(request, 'created_at'))}</td>
                <td>{llmKindLabel(field(request, 'request_kind'))}</td>
                <td>{field(request, 'model')}</td>
                <td>{field(request, 'user_username') ? `@${field(request, 'user_username')}` : field(request, 'user_telegram_id') || '—'}</td>
                <td>
                  <span className={request.has_error === true ? 'badge badge-error' : 'badge'}>
                    {request.has_error === true ? 'ошибка' : 'ок'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination page={page} total={total} onPageChange={setPage} />
      </div>
      <aside className="panel detail-panel">
        {!selected && <EmptyState>Выберите запрос.</EmptyState>}
        {selected && (
          <>
            <div className="section-title">{llmKindLabel(field(selected, 'request_kind'))}</div>
            <dl className="meta-list">
              <dt>ID</dt>
              <dd>{field(selected, 'id')}</dd>
              <dt>Время</dt>
              <dd>{formatDate(field(selected, 'created_at'))}</dd>
              <dt>Провайдер</dt>
              <dd>{field(selected, 'provider')}</dd>
              <dt>Модель</dt>
              <dd>{field(selected, 'model')}</dd>
              <dt>Пользователь</dt>
              <dd>{field(selected, 'user_username') ? `@${field(selected, 'user_username')}` : field(selected, 'user_telegram_id') || '—'}</dd>
              <dt>Сессия</dt>
              <dd>{field(selected, 'session_id') ? shortId(field(selected, 'session_id')) : '—'}</dd>
              <dt>Токены</dt>
              <dd>{tokenUsageSummary(selected.token_usage)}</dd>
              <dt>Стоимость</dt>
              <dd>{moneyMillicents(field(selected, 'cost_millicents'))}</dd>
              <dt>Результат</dt>
              <dd>{selected.has_error === true ? 'ошибка' : 'успех'}</dd>
            </dl>
            {field(selected, 'error_text') && (
              <>
                <div className="subhead">Ошибка</div>
                <pre className="json-box error-box">{field(selected, 'error_text')}</pre>
              </>
            )}
            <div className="subhead">Параметры модели</div>
            <pre className="json-box">{jsonPreview(selected.model_params)}</pre>
            <div className="subhead">Запрос</div>
            <pre className="json-box">{field(selected, 'request_text') || '—'}</pre>
            <div className="subhead">Ответ</div>
            <pre className="json-box">{field(selected, 'response_text') || '—'}</pre>
            <RetrievedDocuments value={selected.retrieved_documents} />
          </>
        )}
      </aside>
    </section>
  );
}

// Документы экспертизы, подтянутые векторным поиском при работе бота поддержки
// (issue #147). Сохраняются в llm_request_logs.retrieved_documents как JSON и
// показываются здесь, чтобы видеть, какая справка попала в промпт.
function RetrievedDocuments({ value }: { value: unknown }): ReactNode {
  const docs = Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
  if (docs.length === 0) return null;
  return (
    <>
      <div className="subhead">Подтянутая экспертиза · {docs.length}</div>
      <table>
        <thead>
          <tr>
            <th>Документ</th>
            <th>Совпавшая фраза</th>
            <th>Сходство</th>
          </tr>
        </thead>
        <tbody>
          {docs.map((doc, index) => {
            const similarity = typeof doc.similarity === 'number' ? doc.similarity : null;
            return (
              <tr key={`${String(doc.id ?? index)}`}>
                <td>{String(doc.title ?? '—')}</td>
                <td>{String(doc.matchedSource ?? '—')}</td>
                <td>{similarity === null ? '—' : `${(similarity * 100).toFixed(1)}%`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

// Раздел «Azure»: просмотр, добавление и редактирование алиасов моделей Azure
// (таблица azure_models, issue #124). Алиас — имя deployment в Azure, model —
// каноническая модель из справочника цен, по которой считается стоимость.
function AzureModelsView({
  token,
  entityId,
  onSelect,
}: {
  token: string;
  entityId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [models, setModels] = useState<ApiRecord[]>([]);
  const selectedAlias = entityId;
  const [modelText, setModelText] = useState('');
  const [newAlias, setNewAlias] = useState('');
  const [newModel, setNewModel] = useState('');
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    apiFetch<{ items: ApiRecord[] }>(token, '/api/azure-models')
      .then((data) => {
        setModels(data.items);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить алиасы Azure'));
  }, [token, refresh]);

  const selected = useMemo(
    () => models.find((model) => field(model, 'alias') === selectedAlias) ?? null,
    [models, selectedAlias],
  );

  useEffect(() => {
    setModelText(selected ? field(selected, 'model') : '');
  }, [selected]);

  async function saveModel(): Promise<void> {
    if (!selectedAlias) return;
    try {
      await apiFetch(token, `/api/azure-models/${encodeURIComponent(selectedAlias)}`, {
        method: 'PATCH',
        body: JSON.stringify({ model: modelText.trim() }),
      });
      setRefresh((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить алиас');
    }
  }

  async function deleteModel(): Promise<void> {
    if (!selectedAlias) return;
    try {
      await apiFetch(token, `/api/azure-models/${encodeURIComponent(selectedAlias)}`, {
        method: 'DELETE',
      });
      onSelect(null);
      setRefresh((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить алиас');
    }
  }

  async function createModel(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      const created = await apiFetch<ApiRecord>(token, '/api/azure-models', {
        method: 'POST',
        body: JSON.stringify({ alias: newAlias.trim(), model: newModel.trim() }),
      });
      onSelect(field(created, 'alias'));
      setNewAlias('');
      setNewModel('');
      setRefresh((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось добавить алиас');
    }
  }

  return (
    <section className="view-grid">
      <div className="panel list-panel">
        <div className="toolbar">
          <ToolbarButton icon={RefreshCw} onClick={() => setRefresh((value) => value + 1)}>Обновить</ToolbarButton>
        </div>
        <div className="section-title">Алиасы Azure · {models.length}</div>
        <ErrorLine message={error} />
        <table>
          <thead>
            <tr>
              <th>Алиас (deployment)</th>
              <th>Модель</th>
              <th>Обновлён</th>
            </tr>
          </thead>
          <tbody>
            {models.map((model) => (
              <tr key={field(model, 'alias')} onClick={() => onSelect(field(model, 'alias'))}>
                <td>{field(model, 'alias')}</td>
                <td>{field(model, 'model')}</td>
                <td>{formatDate(field(model, 'updated_at'))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <form className="create-box" onSubmit={createModel}>
          <div className="subhead">Добавить алиас</div>
          <input value={newAlias} onChange={(event) => setNewAlias(event.target.value)} placeholder="алиас (имя deployment в Azure)" />
          <input value={newModel} onChange={(event) => setNewModel(event.target.value)} placeholder="каноническая модель (напр. gpt-4o-mini)" />
          <ToolbarButton icon={Plus} type="submit">Добавить</ToolbarButton>
        </form>
      </div>
      <aside className="panel detail-panel">
        {!selected && <EmptyState>Выберите алиас.</EmptyState>}
        {selected && (
          <>
            <div className="section-title">{field(selected, 'alias')}</div>
            <dl className="meta-list">
              <dt>Алиас</dt>
              <dd>{field(selected, 'alias')}</dd>
              <dt>Создан</dt>
              <dd>{formatDate(field(selected, 'created_at'))}</dd>
              <dt>Обновлён</dt>
              <dd>{formatDate(field(selected, 'updated_at'))}</dd>
            </dl>
            <label className="editor-label compact">
              Каноническая модель
              <input value={modelText} onChange={(event) => setModelText(event.target.value)} />
            </label>
            <div className="button-row">
              <ToolbarButton icon={Save} onClick={saveModel}>Сохранить модель</ToolbarButton>
              <ToolbarButton icon={Trash2} onClick={deleteModel}>Удалить алиас</ToolbarButton>
            </div>
          </>
        )}
      </aside>
    </section>
  );
}

// Раздел «Экспертиза»: документы справочной базы первой линии поддержки
// (issue #147). Каждый документ — это заголовок (для админа), контент (попадает
// в промпт бота) и набор поисковых фраз, по которым считаются эмбеддинги. При
// сохранении фраз backend пересчитывает векторы (OpenAI/Azure embeddings),
// по которым бот подтягивает документы во время диалога с клиентом.
function ExpertiseView({
  token,
  entityId,
  onSelect,
}: {
  token: string;
  entityId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [docs, setDocs] = useState<ApiRecord[]>([]);
  const [games, setGames] = useState<ApiRecord[]>([]);
  const selectedId = entityId;
  const [selected, setSelected] = useState<ApiRecord | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  // Вкладки: документы экспертизы, аналитика поисковых запросов (issue #156) либо
  // проверка работы поиска по произвольному ключу (issue #164).
  const [tab, setTab] = useState<'docs' | 'queries' | 'search'>('docs');
  const importInputRef = useRef<HTMLInputElement>(null);

  // Поля редактирования выбранного документа.
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editSources, setEditSources] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editGameId, setEditGameId] = useState('');

  // Поля формы создания.
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newSources, setNewSources] = useState('');
  const [newTags, setNewTags] = useState('');
  const [newGameId, setNewGameId] = useState('');

  useEffect(() => {
    apiFetch<{ items: ApiRecord[] }>(token, '/api/expertise')
      .then((data) => {
        setDocs(data.items);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить документы экспертизы'));
  }, [token, refresh]);

  // Список игр для селектора привязки документа (issue #154).
  useEffect(() => {
    apiFetch<ListResponse<ApiRecord>>(token, '/api/games?limit=100&offset=0')
      .then((data) => setGames(data.items))
      .catch(() => setGames([]));
  }, [token]);

  // Человекочитаемое имя игры по game_id (для колонки списка).
  const gameName = (gameId: string): string => {
    if (!gameId) return 'Поддержка';
    const game = games.find((item) => field(item, 'game_id') === gameId);
    return game ? field(game, 'name') || gameId : gameId;
  };

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    apiFetch<ApiRecord>(token, `/api/expertise/${selectedId}`)
      .then((doc) => {
        setSelected(doc);
        setEditTitle(field(doc, 'title'));
        setEditContent(field(doc, 'content'));
        setEditSources(fieldArray(doc, 'embedding_sources').join('\n'));
        setEditTags(fieldArray(doc, 'tags').join(', '));
        setEditGameId(field(doc, 'game_id'));
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить документ'));
  }, [token, selectedId, refresh]);

  async function saveDoc(): Promise<void> {
    if (!selectedId) return;
    try {
      await apiFetch(token, `/api/expertise/${selectedId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: editTitle.trim(),
          content: editContent.trim(),
          embeddingSources: splitLines(editSources),
          tags: splitTags(editTags),
          gameId: editGameId || null,
        }),
      });
      setRefresh((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить документ');
    }
  }

  async function deleteDoc(): Promise<void> {
    if (!selectedId) return;
    try {
      await apiFetch(token, `/api/expertise/${selectedId}`, { method: 'DELETE' });
      onSelect(null);
      setRefresh((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить документ');
    }
  }

  async function createDoc(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      const created = await apiFetch<ApiRecord>(token, '/api/expertise', {
        method: 'POST',
        body: JSON.stringify({
          title: newTitle.trim(),
          content: newContent.trim(),
          embeddingSources: splitLines(newSources),
          tags: splitTags(newTags),
          gameId: newGameId || null,
        }),
      });
      onSelect(field(created, 'id'));
      setNewTitle('');
      setNewContent('');
      setNewSources('');
      setNewTags('');
      setNewGameId('');
      setRefresh((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать документ');
    }
  }

  async function exportDocs(): Promise<void> {
    try {
      const data = await apiFetch<ApiRecord>(token, '/api/expertise/export');
      downloadJsonFile(`tg-games-expertise-${fileTimestamp()}.json`, data);
      setError('');
      setNotice('JSON-файл документов экспертизы подготовлен.');
    } catch (err) {
      setNotice('');
      setError(err instanceof Error ? err.message : 'Не удалось экспортировать документы');
    }
  }

  async function importDocs(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text()) as unknown;
      const result = await apiFetch<ImportSummary>(token, '/api/expertise/import', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setError('');
      setNotice(importSummaryText(result));
      setRefresh((value) => value + 1);
    } catch (err) {
      setNotice('');
      setError(
        err instanceof SyntaxError
          ? 'Не удалось прочитать JSON-файл'
          : err instanceof Error
            ? err.message
            : 'Не удалось импортировать документы',
      );
    }
  }

  const tabs = (
    <div className="toolbar tab-bar">
      <button
        type="button"
        className={tab === 'docs' ? 'button button-active' : 'button'}
        onClick={() => setTab('docs')}
      >
        <InlineIcon icon={BookOpen} />
        <span>Документы</span>
      </button>
      <button
        type="button"
        className={tab === 'queries' ? 'button button-active' : 'button'}
        onClick={() => setTab('queries')}
      >
        <InlineIcon icon={Search} />
        <span>Поисковые запросы</span>
      </button>
      <button
        type="button"
        className={tab === 'search' ? 'button button-active' : 'button'}
        onClick={() => setTab('search')}
      >
        <InlineIcon icon={SearchCheck} />
        <span>Проверка поиска</span>
      </button>
    </div>
  );

  if (tab === 'queries') {
    return (
      <div className="expertise-view">
        {tabs}
        <ExpertiseQueriesTab token={token} games={games} gameName={gameName} />
      </div>
    );
  }

  if (tab === 'search') {
    return (
      <div className="expertise-view">
        {tabs}
        <ExpertiseSearchTab token={token} games={games} gameName={gameName} />
      </div>
    );
  }

  return (
    <div className="expertise-view">
      {tabs}
      <section className="view-grid wide-detail">
      <div className="panel list-panel">
        <div className="toolbar">
          <ToolbarButton icon={RefreshCw} onClick={() => setRefresh((value) => value + 1)}>Обновить</ToolbarButton>
          <ToolbarButton icon={Download} onClick={exportDocs}>Экспорт</ToolbarButton>
          <ToolbarButton icon={Upload} onClick={() => importInputRef.current?.click()}>Импорт</ToolbarButton>
          <input
            ref={importInputRef}
            className="file-input"
            type="file"
            accept="application/json,.json"
            onChange={importDocs}
          />
        </div>
        <div className="section-title">Документы экспертизы · {docs.length}</div>
        <ErrorLine message={error} />
        <MessageLine message={notice} />
        <table>
          <thead>
            <tr>
              <th>Заголовок</th>
              <th>Привязка</th>
              <th>Тэги</th>
              <th>Эмбеддингов</th>
              <th>Обновлён</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((doc) => (
              <tr key={field(doc, 'id')} onClick={() => onSelect(field(doc, 'id'))}>
                <td>{field(doc, 'title')}</td>
                <td>{gameName(field(doc, 'game_id'))}</td>
                <td>{fieldArray(doc, 'tags').join(', ')}</td>
                <td>{field(doc, 'embedding_count') || '0'}</td>
                <td>{formatDate(field(doc, 'updated_at'))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <form className="create-box" onSubmit={createDoc}>
          <div className="subhead">Новый документ</div>
          <input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="заголовок (для админа)" />
          <textarea value={newContent} onChange={(event) => setNewContent(event.target.value)} placeholder="контент документа (попадает в промпт)" rows={4} />
          <textarea value={newSources} onChange={(event) => setNewSources(event.target.value)} placeholder="поисковые фразы — по одной на строку" rows={3} />
          <input value={newTags} onChange={(event) => setNewTags(event.target.value)} placeholder="тэги — через запятую (issue #321)" />
          <select value={newGameId} onChange={(event) => setNewGameId(event.target.value)} title="Привязка к игре">
            <option value="">Служба поддержки (без игры)</option>
            {games.map((game) => (
              <option key={field(game, 'game_id')} value={field(game, 'game_id')}>
                {field(game, 'name') || field(game, 'game_id')}
              </option>
            ))}
          </select>
          <ToolbarButton icon={Plus} type="submit">Создать</ToolbarButton>
        </form>
      </div>
      <aside className="panel detail-panel">
        {!selected && <EmptyState>Выберите документ или создайте новый.</EmptyState>}
        {selected && (
          <>
            <div className="section-title">{field(selected, 'title')}</div>
            <dl className="meta-list">
              <dt>ID</dt>
              <dd>{field(selected, 'id')}</dd>
              <dt>Создан</dt>
              <dd>{formatDate(field(selected, 'created_at'))}</dd>
              <dt>Обновлён</dt>
              <dd>{formatDate(field(selected, 'updated_at'))}</dd>
            </dl>
            <label className="editor-label compact">
              Заголовок
              <input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} />
            </label>
            <label className="editor-label compact">
              Контент (попадает в промпт бота)
              <textarea value={editContent} onChange={(event) => setEditContent(event.target.value)} rows={8} />
            </label>
            <label className="editor-label compact">
              Поисковые фразы (по одной на строку — пересчитают эмбеддинги)
              <textarea value={editSources} onChange={(event) => setEditSources(event.target.value)} rows={5} />
            </label>
            <label className="editor-label compact">
              Тэги (через запятую — фильтр узла knowledge_query, issue #321)
              <input value={editTags} onChange={(event) => setEditTags(event.target.value)} />
            </label>
            <label className="editor-label compact">
              Привязка к игре (issue #154)
              <select value={editGameId} onChange={(event) => setEditGameId(event.target.value)}>
                <option value="">Служба поддержки (без игры)</option>
                {games.map((game) => (
                  <option key={field(game, 'game_id')} value={field(game, 'game_id')}>
                    {field(game, 'name') || field(game, 'game_id')}
                  </option>
                ))}
              </select>
            </label>
            <div className="button-row">
              <ToolbarButton icon={Save} onClick={saveDoc}>Сохранить</ToolbarButton>
              <ToolbarButton icon={Trash2} onClick={deleteDoc}>Удалить</ToolbarButton>
            </div>
          </>
        )}
      </aside>
      </section>
    </div>
  );
}

// ── Раздел «Онтология» (issue #323) ───────────────────────────────────────
// Концептуальная онтология — параллельная RAG база знаний игры в виде
// типизированного графа: концепты (вершины) и связи (рёбра). В отличие от
// экспертизы граф всегда привязан к конкретной игре, поэтому раздел начинается
// с выбора игры. Редактор повторяет раздел «Экспертиза»: таблица + форма
// создания + панель правки; плюс вкладка визуализации графа.

interface OntologyResponse {
  gameId: string;
  concepts: ApiRecord[];
  relations: ApiRecord[];
}

// Сообщества графа онтологии (issue #328, Graph RAG): кластеры концептов со
// сводкой от LLM. Отдаются отдельным эндпоинтом, только для чтения.
interface CommunityResponse {
  gameId: string;
  communities: ApiRecord[];
}

// Бейдж происхождения элемента онтологии (issue #328, Graph RAG): отличает
// автоизвлечённое LLM ('extracted') от ручной либо уже подтверждённой разметки
// ('authored'). Извлечённое подсвечиваем — его стоит проверить и подтвердить.
function OriginBadge({ origin }: { origin: string }) {
  if (origin === 'extracted') {
    return <span className="badge badge-extracted">извлечено</span>;
  }
  return <span className="badge badge-authored">вручную</span>;
}

// Парсит вес из строки: положительное конечное число либо undefined (бэкенд
// подставит дефолт 1).
function parseWeight(value: string): number | undefined {
  const num = Number.parseFloat(value);
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

// Визуализация графа онтологии (issue #323). Раскладывает концепты по кругу и
// рисует связи стрелками. Только для просмотра — правка идёт через таблицы.
function OntologyGraph({
  concepts,
  relations,
}: {
  concepts: ApiRecord[];
  relations: ApiRecord[];
}) {
  const { nodes, edges } = useMemo(() => {
    const count = Math.max(concepts.length, 1);
    const radius = 80 + count * 26;
    const center = radius + 60;
    const nodeList: Node[] = concepts.map((concept, index) => {
      const angle = (2 * Math.PI * index) / count - Math.PI / 2;
      return {
        id: field(concept, 'slug'),
        position: {
          x: center + radius * Math.cos(angle),
          y: center + radius * Math.sin(angle),
        },
        data: { label: `${field(concept, 'title')}\n(${field(concept, 'kind')})` },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          width: 150,
          fontSize: 11,
          whiteSpace: 'pre-line',
          textAlign: 'center',
          borderRadius: 8,
        },
      } satisfies Node;
    });
    const edgeList: Edge[] = relations.map((relation, index) => ({
      id: `${field(relation, 'id')}-${index}`,
      source: field(relation, 'from_slug'),
      target: field(relation, 'to_slug'),
      label: field(relation, 'relation'),
      markerEnd: { type: MarkerType.ArrowClosed },
      labelStyle: { fontSize: 10 },
    }));
    return { nodes: nodeList, edges: edgeList };
  }, [concepts, relations]);

  if (concepts.length === 0) {
    return <EmptyState>В графе пока нет концептов.</EmptyState>;
  }

  return (
    <div className="ontology-graph" style={{ height: 520 }}>
      <ReactFlow nodes={nodes} edges={edges} fitView nodesDraggable={false} nodesConnectable={false}>
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function OntologyView({ token }: { token: string }) {
  const [games, setGames] = useState<ApiRecord[]>([]);
  const [gameId, setGameId] = useState('');
  const [concepts, setConcepts] = useState<ApiRecord[]>([]);
  const [relations, setRelations] = useState<ApiRecord[]>([]);
  const [communities, setCommunities] = useState<ApiRecord[]>([]);
  const [tab, setTab] = useState<'concepts' | 'relations' | 'communities' | 'graph'>('concepts');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const importInputRef = useRef<HTMLInputElement>(null);

  const [selectedConceptId, setSelectedConceptId] = useState<string | null>(null);
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(null);

  // Поля правки концепта.
  const [cSlug, setCSlug] = useState('');
  const [cKind, setCKind] = useState('');
  const [cTitle, setCTitle] = useState('');
  const [cSynonyms, setCSynonyms] = useState('');
  const [cFact, setCFact] = useState('');
  const [cWeight, setCWeight] = useState('');

  // Поля создания концепта.
  const [ncSlug, setNcSlug] = useState('');
  const [ncKind, setNcKind] = useState('');
  const [ncTitle, setNcTitle] = useState('');
  const [ncSynonyms, setNcSynonyms] = useState('');
  const [ncFact, setNcFact] = useState('');
  const [ncWeight, setNcWeight] = useState('');

  // Поля правки связи.
  const [rFrom, setRFrom] = useState('');
  const [rTo, setRTo] = useState('');
  const [rRelation, setRRelation] = useState('');
  const [rWeight, setRWeight] = useState('');
  const [rCondition, setRCondition] = useState('');
  const [rNote, setRNote] = useState('');

  // Поля создания связи.
  const [nrFrom, setNrFrom] = useState('');
  const [nrTo, setNrTo] = useState('');
  const [nrRelation, setNrRelation] = useState('');
  const [nrWeight, setNrWeight] = useState('');
  const [nrCondition, setNrCondition] = useState('');
  const [nrNote, setNrNote] = useState('');

  // Список игр для селектора. Граф всегда принадлежит игре, поэтому без выбора
  // игры раздел не работает; по умолчанию выбираем первую игру.
  useEffect(() => {
    apiFetch<ListResponse<ApiRecord>>(token, '/api/games?limit=100&offset=0')
      .then((data) => {
        setGames(data.items);
        setGameId((current) => current || (data.items[0] ? field(data.items[0], 'game_id') : ''));
      })
      .catch(() => setGames([]));
  }, [token]);

  // Загрузка графа выбранной игры.
  useEffect(() => {
    if (!gameId) {
      setConcepts([]);
      setRelations([]);
      setCommunities([]);
      return;
    }
    apiFetch<OntologyResponse>(token, `/api/ontology?gameId=${encodeURIComponent(gameId)}`)
      .then((data) => {
        setConcepts(data.concepts);
        setRelations(data.relations);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить онтологию'));
    // Сообщества — необязательная надстройка Graph RAG (#328): грузим best-effort,
    // чтобы их отсутствие/ошибка не ломали основной редактор графа.
    apiFetch<CommunityResponse>(token, `/api/ontology/communities?gameId=${encodeURIComponent(gameId)}`)
      .then((data) => setCommunities(data.communities))
      .catch(() => setCommunities([]));
  }, [token, gameId, refresh]);

  const selectedConcept = useMemo(
    () => concepts.find((row) => field(row, 'id') === selectedConceptId) ?? null,
    [concepts, selectedConceptId],
  );
  const selectedRelation = useMemo(
    () => relations.find((row) => field(row, 'id') === selectedRelationId) ?? null,
    [relations, selectedRelationId],
  );

  // Синхронизация полей редактора с выбранным концептом.
  useEffect(() => {
    if (!selectedConcept) return;
    setCSlug(field(selectedConcept, 'slug'));
    setCKind(field(selectedConcept, 'kind'));
    setCTitle(field(selectedConcept, 'title'));
    setCSynonyms(fieldArray(selectedConcept, 'synonyms').join('\n'));
    setCFact(field(selectedConcept, 'fact'));
    setCWeight(field(selectedConcept, 'weight'));
  }, [selectedConcept]);

  useEffect(() => {
    if (!selectedRelation) return;
    setRFrom(field(selectedRelation, 'from_slug'));
    setRTo(field(selectedRelation, 'to_slug'));
    setRRelation(field(selectedRelation, 'relation'));
    setRWeight(field(selectedRelation, 'weight'));
    const condition = selectedRelation.condition;
    setRCondition(condition ? JSON.stringify(condition, null, 2) : '');
    setRNote(field(selectedRelation, 'note'));
  }, [selectedRelation]);

  // Разбор JSON-условия связи: пустая строка → null, иначе объект (или ошибка).
  function parseCondition(value: string): Record<string, unknown> | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Условие должно быть JSON-объектом');
    }
    return parsed as Record<string, unknown>;
  }

  function reload(): void {
    setRefresh((value) => value + 1);
  }

  async function createConcept(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      const created = await apiFetch<ApiRecord>(token, '/api/ontology/concepts', {
        method: 'POST',
        body: JSON.stringify({
          gameId,
          slug: ncSlug.trim(),
          kind: ncKind.trim(),
          title: ncTitle.trim(),
          synonyms: splitLines(ncSynonyms),
          fact: ncFact.trim(),
          weight: parseWeight(ncWeight),
        }),
      });
      setSelectedConceptId(field(created, 'id'));
      setNcSlug('');
      setNcKind('');
      setNcTitle('');
      setNcSynonyms('');
      setNcFact('');
      setNcWeight('');
      setError('');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать концепт');
    }
  }

  async function saveConcept(): Promise<void> {
    if (!selectedConceptId) return;
    try {
      await apiFetch(token, `/api/ontology/concepts/${selectedConceptId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          slug: cSlug.trim(),
          kind: cKind.trim(),
          title: cTitle.trim(),
          synonyms: splitLines(cSynonyms),
          fact: cFact.trim(),
          weight: parseWeight(cWeight),
        }),
      });
      setError('');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить концепт');
    }
  }

  async function deleteConcept(): Promise<void> {
    if (!selectedConceptId) return;
    try {
      await apiFetch(token, `/api/ontology/concepts/${selectedConceptId}`, { method: 'DELETE' });
      setSelectedConceptId(null);
      setError('');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить концепт');
    }
  }

  // Подтверждение извлечённого концепта (issue #328): 'extracted' → 'authored',
  // чтобы переиндексация графа его не перетёрла.
  async function verifyConcept(): Promise<void> {
    if (!selectedConceptId) return;
    try {
      await apiFetch(token, `/api/ontology/concepts/${selectedConceptId}/verify`, { method: 'POST' });
      setError('');
      setNotice('Концепт подтверждён: помечен как ручной (authored).');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось подтвердить концепт');
    }
  }

  async function createRelation(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      const created = await apiFetch<ApiRecord>(token, '/api/ontology/relations', {
        method: 'POST',
        body: JSON.stringify({
          gameId,
          fromSlug: nrFrom.trim(),
          toSlug: nrTo.trim(),
          relation: nrRelation.trim(),
          weight: parseWeight(nrWeight),
          condition: parseCondition(nrCondition),
          note: nrNote.trim(),
        }),
      });
      setSelectedRelationId(field(created, 'id'));
      setNrFrom('');
      setNrTo('');
      setNrRelation('');
      setNrWeight('');
      setNrCondition('');
      setNrNote('');
      setError('');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать связь');
    }
  }

  async function saveRelation(): Promise<void> {
    if (!selectedRelationId) return;
    try {
      await apiFetch(token, `/api/ontology/relations/${selectedRelationId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          fromSlug: rFrom.trim(),
          toSlug: rTo.trim(),
          relation: rRelation.trim(),
          weight: parseWeight(rWeight),
          condition: parseCondition(rCondition),
          note: rNote.trim(),
        }),
      });
      setError('');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить связь');
    }
  }

  async function deleteRelation(): Promise<void> {
    if (!selectedRelationId) return;
    try {
      await apiFetch(token, `/api/ontology/relations/${selectedRelationId}`, { method: 'DELETE' });
      setSelectedRelationId(null);
      setError('');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить связь');
    }
  }

  // Подтверждение извлечённой связи (issue #328): 'extracted' → 'authored'.
  async function verifyRelation(): Promise<void> {
    if (!selectedRelationId) return;
    try {
      await apiFetch(token, `/api/ontology/relations/${selectedRelationId}/verify`, { method: 'POST' });
      setError('');
      setNotice('Связь подтверждена: помечена как ручная (authored).');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось подтвердить связь');
    }
  }

  async function exportOntology(): Promise<void> {
    if (!gameId) return;
    try {
      const data = await apiFetch<ApiRecord>(token, `/api/ontology/export?gameId=${encodeURIComponent(gameId)}`);
      downloadJsonFile(`tg-games-ontology-${gameId}-${fileTimestamp()}.json`, data);
      setError('');
      setNotice('JSON-файл онтологии подготовлен.');
    } catch (err) {
      setNotice('');
      setError(err instanceof Error ? err.message : 'Не удалось экспортировать онтологию');
    }
  }

  async function importOntology(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !gameId) return;
    try {
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>;
      // Привязываем импорт к выбранной игре, игнорируя gameId из файла.
      const payload = { ...parsed, gameId };
      const result = await apiFetch<ImportSummary>(token, '/api/ontology/import', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setError('');
      setNotice(importSummaryText(result));
      reload();
    } catch (err) {
      setNotice('');
      setError(
        err instanceof SyntaxError
          ? 'Не удалось прочитать JSON-файл'
          : err instanceof Error
            ? err.message
            : 'Не удалось импортировать онтологию',
      );
    }
  }

  const tabs = (
    <div className="toolbar tab-bar">
      <button
        type="button"
        className={tab === 'concepts' ? 'button button-active' : 'button'}
        onClick={() => setTab('concepts')}
      >
        <InlineIcon icon={Boxes} />
        <span>Концепты</span>
      </button>
      <button
        type="button"
        className={tab === 'relations' ? 'button button-active' : 'button'}
        onClick={() => setTab('relations')}
      >
        <InlineIcon icon={Workflow} />
        <span>Связи</span>
      </button>
      <button
        type="button"
        className={tab === 'communities' ? 'button button-active' : 'button'}
        onClick={() => setTab('communities')}
      >
        <InlineIcon icon={Layers3} />
        <span>Сообщества</span>
      </button>
      <button
        type="button"
        className={tab === 'graph' ? 'button button-active' : 'button'}
        onClick={() => setTab('graph')}
      >
        <InlineIcon icon={Network} />
        <span>Граф</span>
      </button>
    </div>
  );

  const gameSelector = (
    <div className="toolbar">
      <label className="editor-label compact" style={{ minWidth: 280 }}>
        Игра
        <select value={gameId} onChange={(event) => setGameId(event.target.value)}>
          {games.length === 0 && <option value="">Нет игр</option>}
          {games.map((game) => (
            <option key={field(game, 'game_id')} value={field(game, 'game_id')}>
              {field(game, 'name') || field(game, 'game_id')}
            </option>
          ))}
        </select>
      </label>
      <ToolbarButton icon={RefreshCw} onClick={reload}>Обновить</ToolbarButton>
      <ToolbarButton icon={Download} onClick={exportOntology}>Экспорт</ToolbarButton>
      <ToolbarButton icon={Upload} onClick={() => importInputRef.current?.click()}>Импорт</ToolbarButton>
      <input
        ref={importInputRef}
        className="file-input"
        type="file"
        accept="application/json,.json"
        onChange={importOntology}
      />
    </div>
  );

  return (
    <div className="expertise-view">
      {tabs}
      {gameSelector}
      <ErrorLine message={error} />
      <MessageLine message={notice} />
      {!gameId && <EmptyState>Выберите игру, чтобы работать с её онтологией.</EmptyState>}

      {gameId && tab === 'concepts' && (
        <section className="view-grid wide-detail">
          <div className="panel list-panel">
            <div className="section-title">Концепты · {concepts.length}</div>
            <table>
              <thead>
                <tr>
                  <th>Slug</th>
                  <th>Тип</th>
                  <th>Заголовок</th>
                  <th>Вес</th>
                  <th>Источник</th>
                </tr>
              </thead>
              <tbody>
                {concepts.map((concept) => (
                  <tr key={field(concept, 'id')} onClick={() => setSelectedConceptId(field(concept, 'id'))}>
                    <td>{field(concept, 'slug')}</td>
                    <td>{field(concept, 'kind')}</td>
                    <td>{field(concept, 'title')}</td>
                    <td>{field(concept, 'weight')}</td>
                    <td><OriginBadge origin={field(concept, 'origin')} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <form className="create-box" onSubmit={createConcept}>
              <div className="subhead">Новый концепт</div>
              <input value={ncSlug} onChange={(event) => setNcSlug(event.target.value)} placeholder="slug (уникален в игре)" />
              <input value={ncKind} onChange={(event) => setNcKind(event.target.value)} placeholder="тип (object / action / state …)" />
              <input value={ncTitle} onChange={(event) => setNcTitle(event.target.value)} placeholder="заголовок" />
              <textarea value={ncSynonyms} onChange={(event) => setNcSynonyms(event.target.value)} placeholder="синонимы — по одному на строку" rows={2} />
              <textarea value={ncFact} onChange={(event) => setNcFact(event.target.value)} placeholder="фактура (попадает в промпт)" rows={3} />
              <input value={ncWeight} onChange={(event) => setNcWeight(event.target.value)} placeholder="вес (по умолчанию 1)" />
              <ToolbarButton icon={Plus} type="submit">Создать</ToolbarButton>
            </form>
          </div>
          <aside className="panel detail-panel">
            {!selectedConcept && <EmptyState>Выберите концепт или создайте новый.</EmptyState>}
            {selectedConcept && (
              <>
                <div className="section-title">{field(selectedConcept, 'title')}</div>
                <dl className="meta-list">
                  <dt>ID</dt>
                  <dd>{field(selectedConcept, 'id')}</dd>
                  <dt>Происхождение</dt>
                  <dd><OriginBadge origin={field(selectedConcept, 'origin')} /></dd>
                  {field(selectedConcept, 'source_document_id') && (
                    <>
                      <dt>Документ-источник</dt>
                      <dd>{shortId(field(selectedConcept, 'source_document_id'))}</dd>
                    </>
                  )}
                  <dt>Обновлён</dt>
                  <dd>{formatDate(field(selectedConcept, 'updated_at'))}</dd>
                </dl>
                <label className="editor-label compact">
                  Slug
                  <input value={cSlug} onChange={(event) => setCSlug(event.target.value)} />
                </label>
                <label className="editor-label compact">
                  Тип
                  <input value={cKind} onChange={(event) => setCKind(event.target.value)} />
                </label>
                <label className="editor-label compact">
                  Заголовок
                  <input value={cTitle} onChange={(event) => setCTitle(event.target.value)} />
                </label>
                <label className="editor-label compact">
                  Синонимы (по одному на строку)
                  <textarea value={cSynonyms} onChange={(event) => setCSynonyms(event.target.value)} rows={3} />
                </label>
                <label className="editor-label compact">
                  Фактура (попадает в промпт бота)
                  <textarea value={cFact} onChange={(event) => setCFact(event.target.value)} rows={5} />
                </label>
                <label className="editor-label compact">
                  Вес
                  <input value={cWeight} onChange={(event) => setCWeight(event.target.value)} />
                </label>
                <div className="button-row">
                  <ToolbarButton icon={Save} onClick={saveConcept}>Сохранить</ToolbarButton>
                  {field(selectedConcept, 'origin') === 'extracted' && (
                    <ToolbarButton icon={ShieldCheck} onClick={verifyConcept}>Подтвердить</ToolbarButton>
                  )}
                  <ToolbarButton icon={Trash2} onClick={deleteConcept}>Удалить</ToolbarButton>
                </div>
              </>
            )}
          </aside>
        </section>
      )}

      {gameId && tab === 'relations' && (
        <section className="view-grid wide-detail">
          <div className="panel list-panel">
            <div className="section-title">Связи · {relations.length}</div>
            <table>
              <thead>
                <tr>
                  <th>От</th>
                  <th>Связь</th>
                  <th>К</th>
                  <th>Вес</th>
                  <th>Источник</th>
                </tr>
              </thead>
              <tbody>
                {relations.map((relation) => (
                  <tr key={field(relation, 'id')} onClick={() => setSelectedRelationId(field(relation, 'id'))}>
                    <td>{field(relation, 'from_slug')}</td>
                    <td>{field(relation, 'relation')}</td>
                    <td>{field(relation, 'to_slug')}</td>
                    <td>{field(relation, 'weight')}</td>
                    <td><OriginBadge origin={field(relation, 'origin')} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <form className="create-box" onSubmit={createRelation}>
              <div className="subhead">Новая связь</div>
              <select value={nrFrom} onChange={(event) => setNrFrom(event.target.value)}>
                <option value="">— откуда —</option>
                {concepts.map((concept) => (
                  <option key={field(concept, 'slug')} value={field(concept, 'slug')}>
                    {field(concept, 'slug')} · {field(concept, 'title')}
                  </option>
                ))}
              </select>
              <input value={nrRelation} onChange={(event) => setNrRelation(event.target.value)} placeholder="тип связи (требует / даёт / угрожает …)" />
              <select value={nrTo} onChange={(event) => setNrTo(event.target.value)}>
                <option value="">— куда —</option>
                {concepts.map((concept) => (
                  <option key={field(concept, 'slug')} value={field(concept, 'slug')}>
                    {field(concept, 'slug')} · {field(concept, 'title')}
                  </option>
                ))}
              </select>
              <input value={nrWeight} onChange={(event) => setNrWeight(event.target.value)} placeholder="вес (по умолчанию 1)" />
              <textarea value={nrCondition} onChange={(event) => setNrCondition(event.target.value)} placeholder='условие — JSON-объект, напр. {"season":"зима"}' rows={2} />
              <input value={nrNote} onChange={(event) => setNrNote(event.target.value)} placeholder="заметка (необязательно)" />
              <ToolbarButton icon={Plus} type="submit">Создать</ToolbarButton>
            </form>
          </div>
          <aside className="panel detail-panel">
            {!selectedRelation && <EmptyState>Выберите связь или создайте новую.</EmptyState>}
            {selectedRelation && (
              <>
                <div className="section-title">
                  {field(selectedRelation, 'from_slug')} → {field(selectedRelation, 'to_slug')}
                </div>
                <dl className="meta-list">
                  <dt>ID</dt>
                  <dd>{field(selectedRelation, 'id')}</dd>
                  <dt>Происхождение</dt>
                  <dd><OriginBadge origin={field(selectedRelation, 'origin')} /></dd>
                  {field(selectedRelation, 'source_document_id') && (
                    <>
                      <dt>Документ-источник</dt>
                      <dd>{shortId(field(selectedRelation, 'source_document_id'))}</dd>
                    </>
                  )}
                  <dt>Обновлена</dt>
                  <dd>{formatDate(field(selectedRelation, 'updated_at'))}</dd>
                </dl>
                <label className="editor-label compact">
                  Откуда
                  <select value={rFrom} onChange={(event) => setRFrom(event.target.value)}>
                    {concepts.map((concept) => (
                      <option key={field(concept, 'slug')} value={field(concept, 'slug')}>
                        {field(concept, 'slug')} · {field(concept, 'title')}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="editor-label compact">
                  Тип связи
                  <input value={rRelation} onChange={(event) => setRRelation(event.target.value)} />
                </label>
                <label className="editor-label compact">
                  Куда
                  <select value={rTo} onChange={(event) => setRTo(event.target.value)}>
                    {concepts.map((concept) => (
                      <option key={field(concept, 'slug')} value={field(concept, 'slug')}>
                        {field(concept, 'slug')} · {field(concept, 'title')}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="editor-label compact">
                  Вес
                  <input value={rWeight} onChange={(event) => setRWeight(event.target.value)} />
                </label>
                <label className="editor-label compact">
                  Условие (JSON-объект или пусто)
                  <textarea value={rCondition} onChange={(event) => setRCondition(event.target.value)} rows={3} />
                </label>
                <label className="editor-label compact">
                  Заметка
                  <input value={rNote} onChange={(event) => setRNote(event.target.value)} />
                </label>
                <div className="button-row">
                  <ToolbarButton icon={Save} onClick={saveRelation}>Сохранить</ToolbarButton>
                  {field(selectedRelation, 'origin') === 'extracted' && (
                    <ToolbarButton icon={ShieldCheck} onClick={verifyRelation}>Подтвердить</ToolbarButton>
                  )}
                  <ToolbarButton icon={Trash2} onClick={deleteRelation}>Удалить</ToolbarButton>
                </div>
              </>
            )}
          </aside>
        </section>
      )}

      {gameId && tab === 'communities' && (
        <section className="panel list-panel">
          <div className="section-title">Сообщества графа · {communities.length}</div>
          {communities.length === 0 && (
            <EmptyState>
              Сообществ пока нет. Они появляются после offline-индексации графа
              (бот с GRAPH_RAG_REINDEX_ON_START=true): кластеры концептов со сводкой
              от LLM питают обзорный (global) режим узла ontology_query.
            </EmptyState>
          )}
          {communities.map((community) => (
            <article key={field(community, 'id')} className="community-card">
              <div className="subhead">
                <span>{field(community, 'title')}</span>
                <span className="badge">уровень {field(community, 'level')}</span>
              </div>
              <p>{field(community, 'summary')}</p>
              <div className="community-members">
                {fieldArray(community, 'member_slugs').map((slug) => (
                  <span key={slug} className="badge">{slug}</span>
                ))}
              </div>
            </article>
          ))}
        </section>
      )}

      {gameId && tab === 'graph' && <OntologyGraph concepts={concepts} relations={relations} />}
    </div>
  );
}

// Вкладка аналитики поисковых запросов экспертизы (issue #156). Показывает
// журнал запросов с семантическими/временными/качественными фильтрами и
// выгрузкой текущей выборки в JSON.
interface ExpertiseQueryItem {
  id: string;
  gameId: string | null;
  gameName: string | null;
  queryText: string;
  bestSimilarity: number | null;
  resultCount: number;
  retrievedDocuments: unknown;
  querySimilarity: number | null;
  createdAt: string;
}

// Пресеты фильтра по качеству лучшего совпадения. Позволяют отобрать удачные
// запросы (точное/хорошее совпадение) либо, наоборот, проблемные (ничего не
// нашлось или сходство низкое).
const QUERY_QUALITY_PRESETS: Record<string, { label: string; min?: number; max?: number }> = {
  any: { label: 'Любое качество' },
  exact: { label: 'Точное совпадение (≥ 90%)', min: 0.9 },
  good: { label: 'Хорошее (≥ 70%)', min: 0.7 },
  weak: { label: 'Слабое (≤ 50%)', max: 0.5 },
  none: { label: 'Ничего не найдено', max: 0 },
};

function percentText(value: number | null): string {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
}

function ExpertiseQueriesTab({
  token,
  games,
  gameName,
}: {
  token: string;
  games: ApiRecord[];
  gameName: (gameId: string) => string;
}) {
  const [scope, setScope] = useState('');
  const [before, setBefore] = useState('');
  const [phrase, setPhrase] = useState('');
  const [quality, setQuality] = useState('any');
  const [committed, setCommitted] = useState({ scope: '', before: '', phrase: '', quality: 'any' });

  const [items, setItems] = useState<ExpertiseQueryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    const params = new URLSearchParams({ limit: '200', offset: '0' });
    if (committed.scope === '__support__') params.set('support', 'true');
    else if (committed.scope) params.set('gameId', committed.scope);
    if (committed.before) {
      const iso = new Date(committed.before);
      if (!Number.isNaN(iso.getTime())) params.set('before', iso.toISOString());
    }
    if (committed.phrase.trim()) params.set('phrase', committed.phrase.trim());
    const preset = QUERY_QUALITY_PRESETS[committed.quality];
    if (preset?.min !== undefined) params.set('minSimilarity', String(preset.min));
    if (preset?.max !== undefined) params.set('maxSimilarity', String(preset.max));

    apiFetch<ListResponse<ExpertiseQueryItem>>(token, `/api/expertise/queries?${params.toString()}`)
      .then((data) => {
        setItems(data.items);
        setTotal(data.total ?? data.items.length);
        setPicked(new Set());
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить запросы'));
  }, [token, committed]);

  function applyFilters(event: FormEvent): void {
    event.preventDefault();
    setCommitted({ scope, before, phrase, quality });
  }

  function togglePick(id: string): void {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exportSelection(): void {
    const chosen = picked.size > 0 ? items.filter((item) => picked.has(item.id)) : items;
    if (chosen.length === 0) {
      setNotice('');
      setError('Нет запросов для выгрузки.');
      return;
    }
    downloadJsonFile(`tg-games-expertise-queries-${fileTimestamp()}.json`, {
      version: 1,
      exportedAt: new Date().toISOString(),
      items: chosen,
    });
    setError('');
    setNotice(`Выгружено запросов: ${chosen.length}.`);
  }

  const hasPhrase = committed.phrase.trim().length > 0;

  return (
    <section className="panel">
      <form className="toolbar filters" onSubmit={applyFilters}>
        <select value={scope} onChange={(event) => setScope(event.target.value)} title="Область">
          <option value="">Все области</option>
          <option value="__support__">Служба поддержки</option>
          {games.map((game) => (
            <option key={field(game, 'game_id')} value={field(game, 'game_id')}>
              {field(game, 'name') || field(game, 'game_id')}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="семантический поиск по фразе"
          value={phrase}
          onChange={(event) => setPhrase(event.target.value)}
        />
        <input
          type="datetime-local"
          title="Запросы раньше момента"
          value={before}
          onChange={(event) => setBefore(event.target.value)}
        />
        <select value={quality} onChange={(event) => setQuality(event.target.value)} title="Качество совпадения">
          {Object.entries(QUERY_QUALITY_PRESETS).map(([key, preset]) => (
            <option key={key} value={key}>{preset.label}</option>
          ))}
        </select>
        <ToolbarButton icon={Search} type="submit">Применить</ToolbarButton>
        <ToolbarButton icon={Download} onClick={exportSelection}>Выгрузить выборку</ToolbarButton>
      </form>
      <div className="section-title">
        Поисковые запросы · {items.length}
        {total > items.length ? ` из ${total}` : ''}
        {hasPhrase ? ' · сортировка по близости к фразе' : ''}
      </div>
      <ErrorLine message={error} />
      <MessageLine message={notice} />
      <table>
        <thead>
          <tr>
            <th style={{ width: '2rem' }}></th>
            <th>Запрос</th>
            <th>Область</th>
            <th>{hasPhrase ? 'Близость к фразе' : 'Лучшее совпадение'}</th>
            <th>Найдено</th>
            <th>Дата</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <Fragment key={item.id}>
              <tr onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}>
                <td onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={picked.has(item.id)}
                    onChange={() => togglePick(item.id)}
                  />
                </td>
                <td>{item.queryText}</td>
                <td>{gameName(item.gameId ?? '')}</td>
                <td>{percentText(hasPhrase ? item.querySimilarity : item.bestSimilarity)}</td>
                <td>{item.resultCount}</td>
                <td>{formatDate(item.createdAt)}</td>
              </tr>
              {expandedId === item.id && (
                <tr className="detail-row">
                  <td colSpan={6}>
                    {Array.isArray(item.retrievedDocuments) && item.retrievedDocuments.length > 0 ? (
                      <RetrievedDocuments value={item.retrievedDocuments} />
                    ) : (
                      <div className="empty">Документы не найдены для этого запроса.</div>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {items.length === 0 && <EmptyState>Запросов по фильтрам не найдено.</EmptyState>}
    </section>
  );
}

// Issue #164 — одно совпадение фразы-источника (поискового ключа) документа.
interface ExpertiseSourceMatch {
  documentId: string;
  documentTitle: string;
  gameId: string | null;
  source: string;
  distance: number;
  similarity: number;
}

interface ExpertiseSearchResult {
  query: string;
  embeddingsAvailable: boolean;
  matches: ExpertiseSourceMatch[];
}

// Issue #164 — вкладка «Проверка поиска»: администратор вводит произвольный ключ
// и видит, какие ключи документов экспертизы он находит и насколько близко
// (косинусная близость). Помогает подбирать корректные ключи документов.
function ExpertiseSearchTab({
  token,
  games,
  gameName,
}: {
  token: string;
  games: ApiRecord[];
  gameName: (gameId: string) => string;
}) {
  const [scope, setScope] = useState('');
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<ExpertiseSearchResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function runSearch(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    setLoading(true);
    try {
      const body: Record<string, unknown> = { query: trimmed };
      if (scope === '__support__') body.support = true;
      else if (scope) body.gameId = scope;
      const data = await apiFetch<ExpertiseSearchResult>(token, '/api/expertise/search', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setResult(data);
      setError('');
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : 'Не удалось выполнить поиск');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="panel">
      <form className="toolbar filters" onSubmit={runSearch}>
        <select value={scope} onChange={(event) => setScope(event.target.value)} title="Область">
          <option value="">Все области</option>
          <option value="__support__">Служба поддержки</option>
          {games.map((game) => (
            <option key={field(game, 'game_id')} value={field(game, 'game_id')}>
              {field(game, 'name') || field(game, 'game_id')}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="произвольный поисковый ключ"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ToolbarButton icon={SearchCheck} type="submit" disabled={loading || query.trim().length === 0}>
          Проверить
        </ToolbarButton>
      </form>
      <ErrorLine message={error} />
      {result && !result.embeddingsAvailable && (
        <MessageLine message="Эмбеддинги недоступны (провайдер эмбеддингов не настроен) — поиск вернёт пустой результат." />
      )}
      {result && (
        <>
          <div className="section-title">
            Найдено ключей · {result.matches.length}
            {result.query ? ` · запрос «${result.query}»` : ''}
          </div>
          <table>
            <thead>
              <tr>
                <th>Документ</th>
                <th>Ключ</th>
                <th>Область</th>
                <th>Близость</th>
              </tr>
            </thead>
            <tbody>
              {result.matches.map((match, index) => (
                <tr key={`${match.documentId}-${match.source}-${index}`}>
                  <td>{match.documentTitle}</td>
                  <td>{match.source}</td>
                  <td>{gameName(match.gameId ?? '')}</td>
                  <td>{percentText(match.similarity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.matches.length === 0 && (
            <EmptyState>Совпадений не найдено для «{result.query}».</EmptyState>
          )}
        </>
      )}
    </section>
  );
}

export default App;
