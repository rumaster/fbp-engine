import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { renderHighlightedHtml } from './jsHighlight';
import type {
  ChangeEvent,
  DragEvent as ReactDragEvent,
  FormEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';
import { helpTopicForField, SCHEMA_TEST_HELP, type SchemaHelpTopic } from './schemaTestHelp';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useUpdateNodeInternals,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  CircleDot,
  CircleHelp,
  ClipboardPaste,
  Copy,
  CornerDownRight,
  Download,
  DownloadCloud,
  GripVertical,
  History,
  Locate,
  Maximize2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Scissors,
  Trash2,
  Upload,
  UploadCloud,
  X,
  type LucideIcon,
} from 'lucide-react';
import { ApiError, apiFetch, formatDate, moneyMillicents, type ApiRecord } from './api';
import { ErrorBoundary } from './ErrorBoundary';
import { formatInsertSnippet, insertSnippetAtSelection } from './textEditorInsert';
import {
  CONSTANT_PORT_TYPES,
  SCHEMA_TABS,
  NODE_TYPE_LABELS,
  isNodeType,
  PORT_TYPES,
  canConnectGraphPorts,
  clipboardHasContent,
  cloneGraph,
  connectGraphPorts,
  createGraphNode,
  diffSchemaBundle,
  duplicateGraphNodes,
  extractGraphClipboard,
  formatConfigSummary,
  formatImportSummary,
  getNodePorts,
  isCopyableNode,
  isExecPortId,
  buildTestInputs,
  buildSubSchemaTestInputs,
  buildNodeBodyTestInputs,
  defaultTestInputValues,
  defaultSubSchemaTestInputValues,
  defaultNodeBodyTestInputValues,
  subSchemaTestInputFields,
  nodeBodyTestInputFields,
  parseSchemaBundle,
  loopModeFromConfig,
  collapseBodyGraphFrames,
  reopenBodyGraphFrames,
  getBodyGraph,
  makeEmptyBodyGraph,
  writeBodyGraph,
  makeEmptyGraph,
  makeEmptySubSchemaGraph,
  nodeCategory,
  nodePaletteAvailability,
  normalizeSchemaGraph,
  pasteGraphClipboard,
  paletteKindLabel,
  portColor,
  removeGraphSelection,
  schemaClipboardAction,
  schemaTypeLabel,
  testInputFields,
  shouldDeleteSchemaSelection,
  updateGraphNodePosition,
  updateNodeConfig,
  SUB_SCHEMA_CLASSES,
  boundaryStartPorts,
  boundaryEndPorts,
  graphPaletteKind,
  isBoundaryPortType,
  isSubSchemaClass,
  isSubSchemaGraph,
  isSubSchemaUsableIn,
  subSchemaClassLabel,
  subSchemaConfigPatch,
  type BoundaryPortType,
  type EdgeDefinition,
  type ExistingSchema,
  type GraphClipboard,
  type ImportSummary,
  type LoopBodyFrame,
  type LoopMode,
  type NodeDefinition,
  type NodeType,
  type PortDefinition,
  type PortType,
  type SchemaBoundaryPort,
  type SchemaBundleDiff,
  type SchemaBundleItem,
  type SchemaGraph,
  type SchemaPaletteKind,
  type SchemaType,
  type SubSchemaClass,
} from './schemaGraph';

interface SchemasViewProps {
  token: string;
  entityId: string | null;
  // Выбранная игра (issue #234). null — режим поддержки или базовой (общей) схемы;
  // строка — id игры, для которой редактируются её собственные схемы.
  gameId: string | null;
  // Навигация задаёт одновременно тип схемы и игру — URL воспроизводит конкретную
  // схему конкретной игры из закладки/ссылки.
  onNavigate: (slug: string | null, gameId: string | null) => void;
  // Переход из журнала (issue #288): при открытии схемы из другого раздела указывается
  // id узла, к которому нужно приблизиться и выделить его; null — только открытие схемы.
  focusNodeId?: string | null;
}

// Опция «Базовая (для всех игр)» селектбокса (issue #234): редактирует глобальные
// схемы game_id IS NULL, которые служат fallback для игр без собственной схемы.
const BASE_GAME_VALUE = '__base__';

// Опция «Поддержка» селектбокса (issue #234): глобальная схема службы поддержки,
// открыта по умолчанию при входе на вкладку схем.
const SUPPORT_SCOPE_VALUE = '__support__';

// Типы схем, привязываемых к игре (issue #234). «support» — глобальная схема
// службы поддержки, к играм не привязывается и выбирается отдельной опцией.
const GAME_SCHEMA_SLUGS: SchemaType[] = ['action', 'hint', 'illustration'];

// Зарезервированные slug пайплайн-схем (issue #284): совпадают с типом схемы и не
// могут быть заняты суб-схемой. С issue #310 это уже НЕ дискриминатор суб-схемы —
// принадлежность к суб-схемам определяется классом (`schema_class`/`subSchemaClass`),
// а список нужен лишь для запрета занять зарезервированный slug и для маршрутизации
// глобальной области редактора (slug вне списка ⇒ маршрут суб-схемы).
const RESERVED_PIPELINE_SLUGS: readonly string[] = ['action', 'hint', 'illustration', 'support'];

// Префикс для выбора sub-схемы в scope-селекте (issue #284).
const SUB_SCHEMA_SCOPE_PREFIX = '__sub__:';

// Подписи классов суб-схем для группировки в scope-селекторе (issue #310).
const SUB_SCHEMA_CLASS_GROUP_LABEL: Record<SubSchemaClass, string> = {
  game: 'Игровые',
  support: 'Поддержка',
  common: 'Общие',
};

function isGameSchemaSlug(value: string | null): value is SchemaType {
  return value !== null && (GAME_SCHEMA_SLUGS as string[]).includes(value);
}

// Маршрут суб-схемы (issue #310): в глобальной области slug вне зарезервированных
// пайплайн-слотов ведёт к редактированию суб-схемы. Это лишь признак маршрута —
// сам класс суб-схемы берётся из записи/графа (`schema_class`/`subSchemaClass`).
function isSubSchemaRouteSlug(slug: string): boolean {
  return Boolean(slug) && !RESERVED_PIPELINE_SLUGS.includes(slug);
}

interface SchemaNodeData extends Record<string, unknown> {
  graphNode: NodeDefinition;
  graph: SchemaGraph;
  failedNodeId: string | null;
  onDeleteNode: (nodeId: string) => void;
}

type SchemaFlowNode = Node<SchemaNodeData, 'schemaNode'>;
type SchemaFlowEdge = Edge<{ schemaEdge: EdgeDefinition }>;

interface SchemaTestLogEntry {
  nodeId?: string;
  schemaSlug?: string;
  requestText?: string;
  responseText?: string;
  errorText?: string;
}

// Запись отчёта по узлу теста схемы (issue #347): по КАЖДОЙ ноде потока и по каждой
// pure-ноде, к которой был запрос данных.
interface SchemaTestNodeTraceEntry {
  order: number;
  nodeId: string;
  nodeType: string;
  via: 'flow' | 'data';
  durationMs: number;
  outputKeys: string[];
  outputs: Record<string, unknown>;
  // Снимок входов узла (issue #406): для упавшего узла показываем входы, с которыми
  // он исполнялся, чтобы по логу теста было видно причину сбоя.
  inputs?: Record<string, unknown>;
  schemaSlug: string;
  depth: number;
  failed: boolean;
}

interface SchemaTestResult {
  outputs: Record<string, unknown>;
  llmLog: SchemaTestLogEntry[];
  nodeTrace?: SchemaTestNodeTraceEntry[];
  durationMs: number;
  costMillicents: number;
}

interface ImportPreview {
  graph: SchemaGraph;
  description: string;
  summary: string;
}

// Контекстное меню (issue #248). kind определяет набор действий: pane — вставка/
// добавление, node — копировать/дублировать/удалить, edge — удалить связь.
interface SchemaContextMenu {
  x: number;
  y: number;
  kind: 'pane' | 'node' | 'edge';
  targetId?: string;
}

class SchemaRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: unknown,
  ) {
    super(message);
  }
}

const schemaNodeTypes = { schemaNode: BlueprintNode };

// MIME-тип для переноса узла с палитры на canvas (drag and drop, issue #202).
const NODE_DND_MIME = 'application/x-schema-node';

// Компонент-контроллер фокуса (issue #288): монтируется внутри ReactFlowProvider,
// чтобы иметь доступ к useReactFlow(), и выполняет приближение к узлу при
// изменении focusNodeId. Рендерит null — визуального вывода нет.
function FlowFocusController({
  focusNodeId,
  onFocused,
}: {
  focusNodeId: string | null;
  onFocused: (nodeId: string | null) => void;
}) {
  const { fitView, getNode } = useReactFlow();
  useEffect(() => {
    if (!focusNodeId) return;
    // Небольшая задержка: узлы могут ещё не быть «измерены» сразу после монтирования.
    const timer = setTimeout(() => {
      const node = getNode(focusNodeId);
      if (node) {
        fitView({ nodes: [{ id: focusNodeId }], duration: 400, padding: 0.3 });
        // Выделяем узел только теперь — после монтирования и авто-fitView. Если
        // выставить selected одновременно с fitView на старте, стор ReactFlow
        // зацикливается (React #185, issue #303).
        onFocused(focusNodeId);
      } else {
        fitView({ duration: 300 });
        onFocused(null);
      }
    }, 80);
    return () => clearTimeout(timer);
  }, [focusNodeId, fitView, getNode, onFocused]);
  return null;
}

// Обёртка над canvas: принимает узел, перетащенный с палитры, и добавляет его
// в точке сброса. Должна рендериться внутри ReactFlowProvider, чтобы иметь
// доступ к screenToFlowPosition для перевода экранных координат в координаты графа.
function NodeDropZone({
  onAddNode,
  children,
}: {
  onAddNode: (type: NodeType, position: { x: number; y: number }) => void;
  children: ReactNode;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const handleDragOver = useCallback((event: ReactDragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);
  const handleDrop = useCallback(
    (event: ReactDragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData(NODE_DND_MIME);
      if (!type) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      onAddNode(type as NodeType, position);
    },
    [onAddNode, screenToFlowPosition],
  );
  return (
    <div className="schema-canvas-dropzone" onDragOver={handleDragOver} onDrop={handleDrop}>
      {children}
    </div>
  );
}

const CONDITION_OPERATORS = [
  ['truthy', 'истинно'],
  ['exists', 'существует'],
  ['equals', '='],
  ['not_equals', '!='],
  ['gt', '>'],
  ['gte', '>='],
  ['lt', '<'],
  ['lte', '<='],
] as const;

const LLM_PORT_TYPES = PORT_TYPES.filter((type) => type !== 'exec');

interface LlmPortRow {
  name: string;
  type: PortType;
  description?: string;
  jsonPath?: string;
  path?: string;
}

// Допустимый id граничного порта суб-схемы (issue #310): латиница/цифры/underscore,
// 1..40 символов. Совпадает с BOUNDARY_PORT_ID_PATTERN контракта.
const BOUNDARY_PORT_ID_RE = /^[A-Za-z0-9_]{1,40}$/;

// Граничный порт суб-схемы в редакторе (issue #310): { id, label, type }, где type —
// любой порт данных (PORT_TYPES без exec).
interface BoundaryPortRow {
  id: string;
  label: string;
  type: BoundaryPortType;
}

// Вариант выбора суб-схемы в узле sub_schema (issue #310): помимо slug несёт класс
// (для фильтра совместимости) и снимок граничных портов (для config.ports узла).
interface SubSchemaOption {
  slug: string;
  label: string;
  subSchemaClass: SubSchemaClass;
  ports: { inputs: SchemaBoundaryPort[]; outputs: SchemaBoundaryPort[] };
}

function field(row: ApiRecord | null | undefined, key: string): string {
  const value = row?.[key];
  if (value === null || value === undefined) return '';
  return String(value);
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

function InlineIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon size={16} strokeWidth={2} aria-hidden="true" />;
}

function ToolbarButton({
  icon,
  children,
  onClick,
  type = 'button',
  disabled = false,
  iconOnly = false,
}: {
  icon: LucideIcon;
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  disabled?: boolean;
  iconOnly?: boolean;
}) {
  // В режиме пиктограммы текст прячется, но остаётся доступным как title и
  // aria-label, чтобы кнопки помещались в один ряд (issue #264).
  const label = typeof children === 'string' ? children : undefined;
  return (
    <button
      className={iconOnly ? 'button button-icon' : 'button'}
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={iconOnly ? label : undefined}
      aria-label={iconOnly ? label : undefined}
    >
      <InlineIcon icon={icon} />
      {!iconOnly && <span>{children}</span>}
    </button>
  );
}

function ErrorLine({ message }: { message: string }) {
  if (!message) return null;
  return <div className="error-line">{message}</div>;
}

function MessageLine({ message }: { message: string }) {
  if (!message) return null;
  return <div className="message-line">{message}</div>;
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

// Контекстное меню canvas/узла/ребра (issue #248). Набор действий зависит от
// menu.kind; пункты переиспользуют те же колбэки, что и панель инструментов.
function ContextMenu({
  menu,
  canPaste,
  hasSelection,
  onCopy,
  onCut,
  onDuplicate,
  onPaste,
  onDeleteNodes,
  onDeleteEdge,
}: {
  menu: SchemaContextMenu;
  canPaste: boolean;
  hasSelection: boolean;
  onCopy: () => void;
  onCut: () => void;
  onDuplicate: () => void;
  onPaste: () => void;
  onDeleteNodes: () => void;
  onDeleteEdge: () => void;
}) {
  return (
    <div
      className="schema-context-menu"
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      onClick={(event) => event.stopPropagation()}
    >
      {menu.kind === 'node' && (
        <>
          <button type="button" role="menuitem" onClick={onCopy}>
            <InlineIcon icon={Copy} /> Копировать
          </button>
          <button type="button" role="menuitem" onClick={onCut}>
            <InlineIcon icon={Scissors} /> Вырезать
          </button>
          <button type="button" role="menuitem" onClick={onDuplicate}>
            <InlineIcon icon={Plus} /> Дублировать
          </button>
          <button type="button" role="menuitem" className="danger" onClick={onDeleteNodes}>
            <InlineIcon icon={Trash2} /> Удалить
          </button>
        </>
      )}
      {menu.kind === 'edge' && (
        <button type="button" role="menuitem" className="danger" onClick={onDeleteEdge}>
          <InlineIcon icon={Trash2} /> Удалить связь
        </button>
      )}
      {menu.kind === 'pane' && (
        <>
          {hasSelection && (
            <button type="button" role="menuitem" onClick={onCopy}>
              <InlineIcon icon={Copy} /> Копировать выделение
            </button>
          )}
          <button type="button" role="menuitem" disabled={!canPaste} onClick={onPaste}>
            <InlineIcon icon={ClipboardPaste} /> Вставить
          </button>
        </>
      )}
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

// Пиктограмма-подсказка (?) рядом с лейблом сложной структуры (issue #306). По клику
// открывает модалку с описанием структуры и примерами заполнения, в том числе мокания
// отдельных LLM-узлов.
function HelpHint({ topic }: { topic: SchemaHelpTopic }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="field-help-button"
        onClick={() => setOpen(true)}
        title={`Подсказка: ${topic.title}`}
        aria-label={`Подсказка по структуре «${topic.title}»`}
      >
        <CircleHelp size={15} />
      </button>
      {open && <HelpModal topic={topic} onClose={() => setOpen(false)} />}
    </>
  );
}

// Модалка справки по структуре ввода теста схемы (issue #306): описание, примеры
// заполнения с готовым JSON и дополнительные заметки.
function HelpModal({ topic, onClose }: { topic: SchemaHelpTopic; onClose: () => void }) {
  return (
    <Modal title={topic.title} onClose={onClose}>
      <div className="schema-help">
        {topic.description.map((paragraph, index) => (
          <p key={index} className="schema-help-text">
            {paragraph}
          </p>
        ))}
        {topic.examples.length > 0 && (
          <>
            <div className="subhead">Примеры заполнения</div>
            {topic.examples.map((example, index) => (
              <div key={index} className="schema-help-example">
                <div className="schema-help-caption">{example.caption}</div>
                <pre className="json-box">{example.json}</pre>
              </div>
            ))}
          </>
        )}
        {topic.notes && topic.notes.length > 0 && (
          <ul className="plain-list schema-help-notes">
            {topic.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// Текстовое поле с кнопкой раскрытия (issue #285). Маленькая пиктограмма над полем
// открывает большое модальное окно редактирования, затеняя остальной редактор. В окне
// есть вертикальная панель кнопок с именами входящих портов: для редактора шаблона
// (insertMode='template') клик вставляет шаблон вида {{имя}}, для редактора кода
// (insertMode='code') — голое имя поля. Вставка происходит в позицию курсора.
function ExpandableTextarea({
  value,
  onChange,
  title,
  ports,
  insertMode,
  rows,
  spellCheck,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  title: string;
  ports: string[];
  insertMode: 'template' | 'code';
  rows?: number;
  spellCheck?: boolean;
  placeholder?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  // Слой подсветки прокручивается синхронно с textarea, чтобы выделенные токены
  // оставались под соответствующим текстом (issue #291).
  const syncHighlightScroll = () => {
    const area = textareaRef.current;
    const layer = highlightRef.current;
    if (!area || !layer) return;
    layer.scrollTop = area.scrollTop;
    layer.scrollLeft = area.scrollLeft;
  };

  useEffect(() => {
    if (!expanded) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [expanded]);

  const insertSnippet = (name: string) => {
    const snippet = formatInsertSnippet(name, insertMode);
    const el = textareaRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const result = insertSnippetAtSelection(value, snippet, start, end);
    onChange(result.value);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(result.caret, result.caret);
    });
  };

  return (
    <>
      <div className="expandable-textarea-head">
        <span className="expandable-textarea-title">{title}</span>
        <button
          type="button"
          className="expandable-textarea-toggle"
          title="Раскрыть редактор"
          aria-label="Раскрыть редактор"
          onClick={() => setExpanded(true)}
        >
          <Maximize2 size={14} />
        </button>
      </div>
      <div className="expandable-textarea">
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={rows}
          spellCheck={spellCheck}
          placeholder={placeholder}
        />
      </div>
      {expanded && (
        <div className="modal-overlay" onClick={() => setExpanded(false)} role="presentation">
          <div
            className="modal text-editor-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="modal-head">
              <span className="section-title">{title}</span>
              <button className="icon-button" type="button" onClick={() => setExpanded(false)} title="Закрыть">
                <X size={18} />
              </button>
            </div>
            <div className="modal-body text-editor-body">
              {ports.length > 0 && (
                <div className="text-editor-ports">
                  <div className="subhead">{insertMode === 'template' ? 'Входы' : 'Поля'}</div>
                  {ports.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className="text-editor-port-button"
                      title={insertMode === 'template' ? `Вставить {{${name}}}` : `Вставить ${name}`}
                      onClick={() => insertSnippet(name)}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}
              {insertMode === 'code' ? (
                // Редактор кода: textarea с прозрачным текстом поверх слоя
                // подсветки JS-синтаксиса (issue #291).
                <div className="code-editor-area text-editor-area">
                  <pre className="code-editor-highlight" aria-hidden="true" ref={highlightRef}>
                    <code dangerouslySetInnerHTML={{ __html: renderHighlightedHtml(value) }} />
                  </pre>
                  <textarea
                    ref={textareaRef}
                    className="code-editor-input"
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    onScroll={syncHighlightScroll}
                    spellCheck={spellCheck}
                    placeholder={placeholder}
                    autoFocus
                  />
                </div>
              ) : (
                <textarea
                  ref={textareaRef}
                  className="text-editor-area"
                  value={value}
                  onChange={(event) => onChange(event.target.value)}
                  spellCheck={spellCheck}
                  placeholder={placeholder}
                  autoFocus
                />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function SchemasView({ token, entityId, gameId, onNavigate, focusNodeId }: SchemasViewProps) {
  // Режим выбора схемы из селектбокса (issue #234):
  // - gameMode — выбрана игра: редактируются её собственные схемы (action/hint/illustration),
  //   с наследованием базовой схемы как fallback;
  // - baseMode — выбрана «Базовая (для всех игр)»: правятся глобальные схемы (game_id IS NULL);
  // - supportMode — выбрана «Поддержка»: глобальная схема службы поддержки (по умолчанию).
  // - subSchemaMode — выбрана sub-схема с произвольным slug (issue #284).
  const gameMode = gameId !== null;
  const subSchemaMode = !gameMode && Boolean(entityId) && isSubSchemaRouteSlug(entityId ?? '');
  const baseMode = !gameMode && !subSchemaMode && isGameSchemaSlug(entityId);
  const supportMode = !gameMode && !subSchemaMode && !baseMode;
  // В режиме поддержки активна единственная схема support; в режиме sub-схемы —
  // произвольный slug; иначе — тип схемы игры (по умолчанию «действие», issue #234).
  const activeSlug: string = subSchemaMode
    ? (entityId as string)
    : supportMode
      ? 'support'
      : isGameSchemaSlug(entityId)
        ? entityId
        : 'action';
  const activeTab = SCHEMA_TABS.find((tab) => tab.slug === activeSlug) ?? SCHEMA_TABS[0];
  // Игра, для которой выполняются запросы. Базовая и поддержка — глобальные схемы
  // (game_id NULL), поэтому requestGameId у них null.
  const requestGameId = gameMode ? gameId : null;
  const gameQuery = requestGameId ? `?gameId=${encodeURIComponent(requestGameId)}` : '';
  // Список игр для селектбокса (issue #234).
  const [games, setGames] = useState<ApiRecord[]>([]);
  const [schemas, setSchemas] = useState<ApiRecord[]>([]);
  const [graph, setGraph] = useState<SchemaGraph | null>(null);
  // Стек открытых тел loop-узлов (issue #337): пустой — редактируется корневой граф,
  // непустой — на канвасе показано тело самого глубокого цикла. `graph` всегда хранит
  // текущий отображаемый граф; родительские графы лежат в кадрах и сворачиваются в
  // корень при сохранении/экспорте/авто-сохранении черновика.
  const [loopStack, setLoopStack] = useState<LoopBodyFrame[]>([]);
  const [description, setDescription] = useState('');
  // Множественное выделение узлов (issue #230): box-select по Shift+drag и
  // Shift+click добавляют узлы в выделение; массовые операции работают над всем
  // набором. Для панелей свойств единичный выбор выводится из массива.
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  // Буфер обмена узлов/рёбер для copy-cut-paste (issue #230). Хранится в state,
  // а не в системном clipboard, чтобы переносить структуру графа без сериализации.
  const [clipboard, setClipboard] = useState<GraphClipboard | null>(null);
  const [failedNodeId, setFailedNodeId] = useState<string | null>(null);
  // Замеренные ReactFlow габариты узлов (id → {width, height}). Граф пересоздаёт
  // объекты узлов при каждом перемещении, из-за чего ReactFlow теряет measured и
  // на перетаскивании ругается «node is not initialized» (reactflow.dev/error#015),
  // что в production-сборке всплывает как «Minified React error #185» (issue #215).
  // Поэтому мы запоминаем габариты из dimensions-изменений и возвращаем их в узлы.
  const [nodeSizes, setNodeSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [dirty, setDirty] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  // Отдельный счётчик для перезагрузки только списка схем в сайдбаре (issue #393).
  // После сохранения граф и позиция камеры обновляются на месте из ответа сервера,
  // поэтому полную перезагрузку редактора (которая сбрасывает камеру и закрывает
  // открытую схему узла) не запускаем — обновляем только список.
  const [listRefresh, setListRefresh] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRows, setHistoryRows] = useState<ApiRecord[]>([]);
  const [historyPreview, setHistoryPreview] = useState<ApiRecord | null>(null);
  // Отметка времени последнего открытия истории — строки с archived_at позже этой
  // отметки считаются новыми и выделяются красным кружком (issue #293).
  const [historyNewSince, setHistoryNewSince] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  // Глобальный импорт бандла всех схем (issue #248). bundlePreview хранит разобранные
  // элементы и клиентский diff (created/updated/unchanged) для предпросмотра до отправки
  // на сервер; bundleBusy блокирует кнопки во время сетевых запросов.
  const [bundlePreview, setBundlePreview] = useState<{ items: SchemaBundleItem[]; diff: SchemaBundleDiff } | null>(null);
  const [bundleBusy, setBundleBusy] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  // Диалог создания новой sub-схемы (issue #284): slug (произвольный) и класс/привязка.
  const [newSubSlugOpen, setNewSubSlugOpen] = useState(false);
  // Параметры только что создаваемой суб-схемы (issue #310): записи в БД ещё нет, поэтому
  // класс и (опциональную) привязку к игре держим в state, пока не откроется её граф и
  // не произойдёт первое сохранение. slug сверяется с активным маршрутом.
  const [pendingSubSchema, setPendingSubSchema] = useState<{
    slug: string;
    subSchemaClass: SubSchemaClass;
    gameId: string | null;
  } | null>(null);
  // Существует ли активная схема в БД (issue #310): GET draft вернул 200. Влияет на
  // сохранение: существующую правим через черновик+промоут, отсутствующую создаём
  // напрямую (PATCH /api/schemas/:slug), т.к. черновик требует уже созданной строки.
  const [schemaPersisted, setSchemaPersisted] = useState(false);
  // Контекстное меню canvas/узла/ребра (issue #248): правый клик открывает меню с
  // действиями над целью. Координаты — экранные (position: fixed).
  const [contextMenu, setContextMenu] = useState<SchemaContextMenu | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const bundleInputRef = useRef<HTMLInputElement>(null);
  // Идёт ли сейчас рамочное выделение (Shift+drag по пустому полотну). Во время
  // этого непрерывного жеста ReactFlow авто-выделяет рёбра между выбранными узлами;
  // если в этот момент прокидывать selected обратно в edges-проп, стор ReactFlow
  // зацикливается и интерфейс падает «Maximum update depth exceeded» (React #185,
  // issue #230). Поэтому выделение рёбер во время рамки не зеркалим, а применяем
  // один раз по завершении жеста.
  const boxSelectingRef = useRef(false);
  // Узел для приближения после открытия схемы из журнала (issue #288): хранится
  // в state, чтобы FlowFocusController получил актуальное значение. После срабатывания
  // сбрасывается в null через onFocused, чтобы повторный рендер не прокручивал снова.
  const [pendingFocusNodeId, setPendingFocusNodeId] = useState<string | null>(focusNodeId ?? null);

  // Нормализуем URL: приводим entityId к разрешённому slug (issue #234), чтобы
  // открытие вкладки без сущности давало «Поддержку», а выбор игры — «Действие».
  useEffect(() => {
    if (entityId !== activeSlug) onNavigate(activeSlug, requestGameId);
  }, [activeSlug, entityId, requestGameId, onNavigate]);

  useEffect(() => {
    apiFetch<{ items: ApiRecord[] }>(token, '/api/schemas')
      .then((data) => setSchemas(data.items))
      .catch(() => setSchemas([]));
  }, [token, refresh, listRefresh]);

  // Список игр для селектбокса (issue #234): берём имена из манифестов.
  useEffect(() => {
    apiFetch<{ items: ApiRecord[] }>(token, '/api/games?limit=200&offset=0')
      .then((data) => setGames(data.items))
      .catch(() => setGames([]));
  }, [token]);

  // Суб-схемы из загруженного списка (issue #310): записи с заданным классом суб-схемы
  // (schema_class). Класс — единственный дискриминатор суб-схемы; slug произвольный.
  const subSchemas = useMemo(
    () => schemas.filter((record) => isSubSchemaClass(field(record, 'schema_class'))),
    [schemas],
  );
  // Метаданные активной суб-схемы (issue #310): строка списка с этим slug без привязки к игре.
  const activeSubSchemaMeta = useMemo(
    () =>
      subSchemaMode
        ? schemas.find(
            (item) => field(item, 'schema_slug') === activeSlug && !field(item, 'game_id'),
          ) ?? null
        : null,
    [subSchemaMode, schemas, activeSlug],
  );
  // Класс активной суб-схемы (issue #310): из метаданных БД, либо из pending-состояния
  // для только что создаваемой суб-схемы (строки ещё нет), иначе common как дефолт.
  const activeSubSchemaClass: SubSchemaClass = useMemo(() => {
    if (!subSchemaMode) return 'common';
    const metaClass = activeSubSchemaMeta ? field(activeSubSchemaMeta, 'schema_class') : '';
    if (isSubSchemaClass(metaClass)) return metaClass;
    if (pendingSubSchema && pendingSubSchema.slug === activeSlug) return pendingSubSchema.subSchemaClass;
    return 'common';
  }, [subSchemaMode, activeSubSchemaMeta, pendingSubSchema, activeSlug]);
  // Вид палитры активной схемы (issue #310): для суб-схемы — класс, для пайплайна — тип.
  // После загрузки графа авторитетен graphPaletteKind(graph); до загрузки — это значение.
  const activePaletteKind: SchemaPaletteKind = subSchemaMode ? activeSubSchemaClass : activeTab.schemaType;

  useEffect(() => {
    setLoading(true);
    setError('');
    setNotice('');
    // Любая (пере)загрузка схемы возвращает редактор к корневому графу (issue #337).
    setLoopStack([]);
    apiFetch<ApiRecord>(token, `/api/schemas/${activeSlug}/draft${gameQuery}`)
      .then((record) => {
        const loaded = normalizeSchemaGraph(record.graph_json);
        setGraph({ ...loaded, slug: activeSlug });
        setDescription(field(record, 'description'));
        // При переходе из журнала схем (issue #288) узел не выделяем здесь: выделение
        // делает FlowFocusController уже после монтирования и авто-fitView. Если выставить
        // selected на узле одновременно с fitView на старте, стор ReactFlow зацикливается
        // («Maximum update depth exceeded», React #185, issue #303).
        setSelectedNodeIds([]);
        setSelectedEdgeIds([]);
        setFailedNodeId(null);
        setDirty(false);
        setHasDraft(record.has_draft === true);
        setSchemaPersisted(true);
        // В режиме игры сервер отдаёт базовую схему как fallback, если у игры нет
        // своей. Подсказываем оператору, что правки сохранятся как схема игры.
        if (gameMode && !field(record, 'game_id')) {
          setNotice('У игры нет собственной схемы — показана базовая. Сохранение создаст схему для этой игры.');
        }
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          setGraph(
            subSchemaMode
              ? makeEmptySubSchemaGraph(
                  activeSlug,
                  activeSubSchemaClass,
                  pendingSubSchema && pendingSubSchema.slug === activeSlug
                    ? pendingSubSchema.gameId ?? undefined
                    : undefined,
                )
              : makeEmptyGraph(activeSlug, activeTab.schemaType),
          );
          setDescription('');
          setSelectedNodeIds([]);
          setSelectedEdgeIds([]);
          setFailedNodeId(null);
          setDirty(false);
          setHasDraft(false);
          setSchemaPersisted(false);
          setNotice(
            gameMode
              ? 'Активная схема не найдена. Открыт пустой граф, его можно сохранить как схему этой игры.'
              : subSchemaMode
                ? 'Sub-схема не найдена. Открыт пустой граф, его можно сохранить.'
                : 'Активная схема не найдена. Открыт пустой граф, его можно сохранить как глобальную схему.',
          );
          return;
        }
        setGraph(null);
        setSchemaPersisted(false);
        setError(err instanceof Error ? err.message : 'Не удалось загрузить схему');
      })
      .finally(() => setLoading(false));
  }, [
    token,
    activeSlug,
    activeSubSchemaClass,
    activeTab.schemaType,
    pendingSubSchema,
    gameQuery,
    gameMode,
    subSchemaMode,
    refresh,
    focusNodeId,
  ]);

  // При изменении focusNodeId извне (переход из журнала схем) обновляем pending state
  // для FlowFocusController (issue #288).
  useEffect(() => {
    setPendingFocusNodeId(focusNodeId ?? null);
  }, [focusNodeId]);

  // beforeunload не используется: изменения автоматически сохраняются как черновик
  // при переключении схемы или смене области (issue #286).

  // Горячие клавиши редактора схем:
  // - Delete удаляет выделение (issue #211): Backspace игнорируем полностью, Delete
  //   срабатывает только вне полей ввода текста, чтобы правка свойств в форме не
  //   приводила к непреднамеренному удалению блока.
  // - Ctrl/Cmd+C/X/V/D — копировать/вырезать/вставить/дублировать выделение (issue #230).
  useEffect(() => {
    if (!graph) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldDeleteSchemaSelection(event.key, document.activeElement)) {
        if (!selectedNodeIds.length && !selectedEdgeIds.length) return;
        event.preventDefault();
        deleteSelection();
        return;
      }
      const action = schemaClipboardAction(event, document.activeElement);
      if (!action) return;
      if (action === 'copy' && !selectedNodeIds.length) return;
      if (action === 'cut' && !selectedNodeIds.length) return;
      if (action === 'duplicate' && !selectedNodeIds.length) return;
      if (action === 'paste' && !clipboardHasContent(clipboard)) return;
      event.preventDefault();
      if (action === 'copy') copySelection();
      else if (action === 'cut') cutSelection();
      else if (action === 'paste') pasteClipboard();
      else if (action === 'duplicate') duplicateSelection();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [graph, selectedNodeIds, selectedEdgeIds, clipboard]);

  const deleteNode = useCallback((nodeId: string) => {
    setGraph((current) => {
      const node = current?.nodes.find((candidate) => candidate.id === nodeId);
      if (!current || !node || node.type === 'start' || node.type === 'end') return current;
      setSelectedNodeIds((selected) => selected.filter((id) => id !== nodeId));
      setSelectedEdgeIds([]);
      setDirty(true);
      return removeGraphSelection(current, [nodeId], []);
    });
  }, []);

  const selectedNodeIdSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);
  const flowNodes = useMemo<SchemaFlowNode[]>(() => {
    if (!graph) return [];
    return graph.nodes.map((node) => {
      const size = nodeSizes[node.id];
      return {
        id: node.id,
        type: 'schemaNode',
        position: node.position,
        selected: selectedNodeIdSet.has(node.id),
        // Возвращаем ранее замеренные габариты, чтобы пересозданный узел оставался
        // «инициализированным» для ReactFlow и перетаскивание не зацикливало измерения.
        ...(size ? { measured: { width: size.width, height: size.height } } : {}),
        data: { graphNode: node, graph, failedNodeId, onDeleteNode: deleteNode },
      };
    });
  }, [deleteNode, failedNodeId, graph, nodeSizes, selectedNodeIdSet]);

  const flowEdges = useMemo<SchemaFlowEdge[]>(() => {
    if (!graph) return [];
    return graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      sourceHandle: edge.fromPort,
      targetHandle: edge.toPort,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed },
      className: isExecPortId(edge.fromPort) ? 'schema-edge-exec' : 'schema-edge-data',
      selected: selectedEdgeIds.includes(edge.id),
      data: { schemaEdge: edge },
    }));
  }, [graph, selectedEdgeIds]);
  // Палитра показывает все базовые узлы (issue #248): недоступные в активной схеме
  // не прячутся, а рендерятся выключенными с подсказкой-причиной. Вид палитры берётся
  // из загруженного графа (авторитетно после нормализации), до загрузки — из маршрута.
  const nodePalette = useMemo(
    () => nodePaletteAvailability(graph ? graphPaletteKind(graph) : activePaletteKind),
    [graph, activePaletteKind],
  );
  // Список суб-схем для выпадающего выбора в узле sub_schema (issue #310): только записи
  // со своим классом суб-схемы (по графу), совместимые с видом текущей схемы по правилам
  // доменов; для каждой берём снимок граничных портов из её графа (без отдельного запроса).
  const subSchemaOptions = useMemo<SubSchemaOption[]>(() => {
    const callerKind: SchemaPaletteKind | undefined = graph ? graphPaletteKind(graph) : activePaletteKind;
    const options: SubSchemaOption[] = [];
    for (const record of schemas) {
      const slug = field(record, 'schema_slug');
      if (!slug || field(record, 'game_id')) continue;
      const rawGraph = record.graph_json;
      if (!isSubSchemaGraph(rawGraph)) continue;
      const subGraph = rawGraph as SchemaGraph;
      const subClass = subGraph.subSchemaClass as SubSchemaClass;
      if (!isSubSchemaUsableIn(subClass, callerKind)) continue;
      options.push({
        slug,
        label: `${subSchemaClassLabel(subClass)} · ${slug}`,
        subSchemaClass: subClass,
        ports: { inputs: boundaryStartPorts(subGraph), outputs: boundaryEndPorts(subGraph) },
      });
    }
    return options;
  }, [schemas, graph, activePaletteKind]);

  // Узлы выделения (без удалённых из графа), единичный — для панели свойств.
  const selectedNodes = selectedNodeIds
    .map((id) => graph?.nodes.find((node) => node.id === id))
    .filter((node): node is NodeDefinition => Boolean(node));
  const selectedNode = selectedNodes.length === 1 ? selectedNodes[0] : null;
  // Сколько узлов выделения можно копировать/удалять (start/end — нельзя).
  const copyableSelectedCount = selectedNodes.filter((node) => isCopyableNode(node)).length;
  const selectedEdges = selectedEdgeIds
    .map((edgeId) => graph?.edges.find((edge) => edge.id === edgeId))
    .filter((edge): edge is EdgeDefinition => Boolean(edge));
  const schemaMeta = schemas.find(
    (item) =>
      field(item, 'schema_slug') === activeSlug &&
      (field(item, 'game_id') || null) === requestGameId,
  );

  const handleNodesChange = useCallback((changes: NodeChange<SchemaFlowNode>[]) => {
    // Узлы контролируемые (selected приходит из state), поэтому изменения выделения
    // от ReactFlow (Shift+клик, рамка) применяем сами — иначе выбор не доходит до
    // state и onSelectionChange не сработает (issue #230).
    const selectChanges = changes.filter(
      (change): change is Extract<NodeChange<SchemaFlowNode>, { type: 'select' }> => change.type === 'select',
    );
    if (selectChanges.length > 0) {
      setSelectedNodeIds((current) => {
        const next = new Set(current);
        for (const change of selectChanges) {
          if (change.selected) next.add(change.id);
          else next.delete(change.id);
        }
        const nextIds = [...next];
        return sameIds(current, nextIds) ? current : nextIds;
      });
    }
    // Замеры габаритов узлов держим отдельно от графа: они не меняют доменную
    // модель и не должны помечать схему как «есть правки» (issue #215).
    const sizeUpdates = changes.filter(
      (change): change is Extract<NodeChange<SchemaFlowNode>, { type: 'dimensions' }> =>
        change.type === 'dimensions' && Boolean(change.dimensions),
    );
    if (sizeUpdates.length > 0) {
      setNodeSizes((prev) => {
        let next = prev;
        for (const change of sizeUpdates) {
          const dimensions = change.dimensions;
          if (!dimensions) continue;
          const existing = next[change.id];
          if (existing && existing.width === dimensions.width && existing.height === dimensions.height) {
            continue;
          }
          if (next === prev) next = { ...prev };
          next[change.id] = { width: dimensions.width, height: dimensions.height };
        }
        return next;
      });
    }
    setGraph((current) => {
      if (!current) return current;
      let next = current;
      let changed = false;
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          next = updateGraphNodePosition(next, change.id, change.position);
          changed = true;
        }
        if (change.type === 'remove') {
          next = removeGraphSelection(next, [change.id], []);
          changed = true;
        }
      }
      if (changed) setDirty(true);
      return next;
    });
  }, []);

  const handleEdgesChange = useCallback((changes: EdgeChange<SchemaFlowEdge>[]) => {
    // Рёбра контролируемые: изменения выделения (клик по ребру) применяем сами.
    // Во время рамочного выделения (boxSelectingRef) пропускаем — иначе round-trip
    // selected → edges-проп зацикливает стор ReactFlow (React #185, issue #230).
    const selectChanges = boxSelectingRef.current
      ? []
      : changes.filter(
          (change): change is Extract<EdgeChange<SchemaFlowEdge>, { type: 'select' }> => change.type === 'select',
        );
    if (selectChanges.length > 0) {
      setSelectedEdgeIds((current) => {
        const next = new Set(current);
        for (const change of selectChanges) {
          if (change.selected) next.add(change.id);
          else next.delete(change.id);
        }
        const nextIds = [...next];
        return sameIds(current, nextIds) ? current : nextIds;
      });
    }
    setGraph((current) => {
      if (!current) return current;
      const removeIds = changes.filter((change) => change.type === 'remove').map((change) => change.id);
      if (removeIds.length === 0) return current;
      setDirty(true);
      return removeGraphSelection(current, [], removeIds);
    });
  }, []);

  const handleConnect = useCallback((connection: Connection) => {
    setGraph((current) => {
      if (!current) return current;
      try {
        const next = connectGraphPorts(current, connection);
        setDirty(true);
        setError('');
        return next;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Не удалось соединить порты');
        return current;
      }
    });
  }, []);

  const isValidConnection = useCallback(
    (connection: Connection | SchemaFlowEdge) =>
      graph
        ? canConnectGraphPorts(graph, {
            source: connection.source ?? null,
            sourceHandle: connection.sourceHandle ?? null,
            target: connection.target ?? null,
            targetHandle: connection.targetHandle ?? null,
          }).valid
        : false,
    [graph],
  );

  // Источник истины по выделению — ReactFlow: box-select по Shift+drag и Shift+click
  // дают набор узлов/рёбер, который мы зеркалим в state (issue #230).
  const handleSelectionChange = useCallback(
    ({ nodes, edges }: OnSelectionChangeParams<SchemaFlowNode, SchemaFlowEdge>) => {
      const nextNodeIds = nodes.map((node) => node.id);
      setSelectedNodeIds((current) => (sameIds(current, nextNodeIds) ? current : nextNodeIds));
      // Узлы зеркалим всегда (они не зацикливают стор), а рёбра — только вне
      // активной рамки: во время жеста их selected не прокидываем (issue #230).
      if (!boxSelectingRef.current) {
        const nextEdgeIds = edges.map((edge) => edge.id);
        setSelectedEdgeIds((current) => (sameIds(current, nextEdgeIds) ? current : nextEdgeIds));
      }
    },
    [],
  );

  // Жест рамочного выделения: пока он идёт, не зеркалим выделение рёбер (см.
  // boxSelectingRef). По завершении сбрасываем флаг — финальный onSelectionChange
  // применит итоговый набор рёбер один раз, без зацикливания (issue #230).
  const handleSelectionStart = useCallback(() => {
    boxSelectingRef.current = true;
  }, []);
  const handleSelectionEnd = useCallback(() => {
    boxSelectingRef.current = false;
  }, []);

  const handlePaneClick = useCallback(() => {
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
    setContextMenu(null);
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // Правый клик по узлу (issue #248): если узел вне выделения — выделяем только его,
  // затем открываем меню действий над узлом.
  const handleNodeContextMenu = useCallback(
    (event: ReactMouseEvent, node: SchemaFlowNode) => {
      event.preventDefault();
      setSelectedNodeIds((current) => (current.includes(node.id) ? current : [node.id]));
      if (!selectedNodeIds.includes(node.id)) setSelectedEdgeIds([]);
      setContextMenu({ x: event.clientX, y: event.clientY, kind: 'node', targetId: node.id });
    },
    [selectedNodeIds],
  );

  const handleEdgeContextMenu = useCallback((event: ReactMouseEvent, edge: SchemaFlowEdge) => {
    event.preventDefault();
    setSelectedEdgeIds([edge.id]);
    setSelectedNodeIds([]);
    setContextMenu({ x: event.clientX, y: event.clientY, kind: 'edge', targetId: edge.id });
  }, []);

  const handlePaneContextMenu = useCallback((event: ReactMouseEvent | MouseEvent) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, kind: 'pane' });
  }, []);

  // Закрываем меню по Escape и любому клику вне него.
  useEffect(() => {
    if (!contextMenu) return undefined;
    const close = () => setContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  // Готовит граф к отправке (issue #310): фиксирует актуальный slug и сохраняет XOR-вид
  // (subSchemaClass для суб-схемы либо schemaType для пайплайна) на основе самого графа.
  // Граф — источник истины: makeEmptyGraph/makeEmptySubSchemaGraph и normalizeSchemaGraph
  // уже проставили нужный дискриминатор, поэтому жёстко подставлять schemaType нельзя —
  // это сломало бы суб-схемы (нарушение XOR на сервере).
  function applyGraphKind(source: SchemaGraph): SchemaGraph {
    return { ...cloneGraph(source), slug: activeSlug };
  }

  // Сохраняет текущий граф как черновик на сервере (issue #286): вызывается при
  // переключении схемы или области, чтобы не терять несохранённые изменения. Для ещё
  // не созданной схемы (нет строки в БД) черновик не сохраняем — её создаёт явное
  // «Сохранить» (issue #310), а draft-эндпоинт требует существующей строки.
  async function autoSaveDraft(): Promise<void> {
    if (!graph || !dirty || !schemaPersisted) return;
    const root = collapseBodyGraphFrames(loopStack, graph);
    const payloadGraph = applyGraphKind(root);
    try {
      const saved = await apiFetch<ApiRecord>(token, `/api/schemas/${activeSlug}/draft${gameQuery}`, {
        method: 'PATCH',
        body: JSON.stringify({
          graphJson: payloadGraph,
          gameId: requestGameId,
        }),
      });
      setHasDraft(saved.has_draft === true);
      setDirty(false);
    } catch {
      // Молчим: авто-сохранение черновика не должно блокировать навигацию.
    }
  }

  // Держим актуальную ссылку на autoSaveDraft, чтобы cleanup при размонтировании
  // видел свежие graph/dirty, а не значения из первого рендера (issue #286).
  const autoSaveRef = useRef(autoSaveDraft);
  autoSaveRef.current = autoSaveDraft;

  // Сохраняем черновик при покидании редактора (требование #4): когда оператор
  // уходит на другую вкладку админки, SchemasView размонтируется — сохраняем
  // незафиксированные правки без предупреждений.
  useEffect(() => {
    return () => {
      void autoSaveRef.current();
    };
  }, []);

  function selectSchema(slug: SchemaType): void {
    if (slug === activeSlug) return;
    void autoSaveDraft();
    onNavigate(slug, requestGameId);
  }

  // Открытие модалки теста (issue #355): сервер прогоняет тест по черновику из БД
  // (row.draft_graph_json ?? row.graph_json), поэтому несохранённые правки редактора
  // сначала фиксируем как черновик. Иначе тест суб-схемы черновика по факту
  // выполнялся бы по последней сохранённой (рабочей) версии — с узлами, которых в
  // текущем черновике уже нет.
  async function openTest(): Promise<void> {
    await autoSaveDraft();
    setTestOpen(true);
  }

  // Переключение области схем из селектбокса (issue #234): «Поддержка», «Базовая»
  // или конкретная игра. При выборе игры по умолчанию открывается «Действие».
  // Добавлена поддержка sub-схем (issue #284): значение с префиксом SUB_SCHEMA_SCOPE_PREFIX.
  function selectScope(value: string): void {
    void autoSaveDraft();
    if (value === SUPPORT_SCOPE_VALUE) {
      onNavigate('support', null);
    } else if (value === BASE_GAME_VALUE) {
      onNavigate('action', null);
    } else if (value.startsWith(SUB_SCHEMA_SCOPE_PREFIX)) {
      const subSlug = value.slice(SUB_SCHEMA_SCOPE_PREFIX.length);
      onNavigate(subSlug, null);
    } else {
      onNavigate('action', value);
    }
  }

  // Значение селектбокса: id игры, либо сентинел базовой/поддержки, либо sub-схема (issue #284).
  const scopeValue = gameMode
    ? (gameId as string)
    : subSchemaMode
      ? `${SUB_SCHEMA_SCOPE_PREFIX}${activeSlug}`
      : baseMode
        ? BASE_GAME_VALUE
        : SUPPORT_SCOPE_VALUE;
  // В режиме поддержки доступна единственная вкладка «Поддержка»; в режиме sub-схемы —
  // нет стандартных вкладок; иначе — три пер-игровых типа схемы (issue #234).
  const visibleTabs = supportMode
    ? SCHEMA_TABS.filter((tab) => tab.slug === 'support')
    : subSchemaMode
      ? []
      : SCHEMA_TABS.filter((tab) => tab.slug !== 'support');

  const addNodeAtPosition = useCallback(
    (type: NodeType, position: { x: number; y: number }): void => {
      setGraph((current) => {
        if (!current) return current;
        try {
          const node = createGraphNode(current, type, position);
          setSelectedNodeIds([node.id]);
          setSelectedEdgeIds([]);
          setDirty(true);
          setError('');
          return { ...current, nodes: [...current.nodes, node] };
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Не удалось добавить узел');
          return current;
        }
      });
    },
    [],
  );

  function deleteSelection(): void {
    if (!graph) return;
    if (!selectedNodeIds.length && !selectedEdgeIds.length) return;
    const next = removeGraphSelection(graph, selectedNodeIds, selectedEdgeIds);
    setGraph(next);
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
    setDirty(true);
  }

  function deleteSelectedEdges(): void {
    if (!graph || selectedEdgeIds.length === 0) return;
    setGraph(removeGraphSelection(graph, [], selectedEdgeIds));
    setSelectedEdgeIds([]);
    setDirty(true);
  }

  // Копирует выбранные узлы и рёбра между ними в буфер (issue #230).
  function copySelection(): boolean {
    if (!graph || !selectedNodeIds.length) return false;
    const snapshot = extractGraphClipboard(graph, selectedNodeIds);
    if (snapshot.nodes.length === 0) return false;
    setClipboard(snapshot);
    setNotice(`Скопировано: ${snapshot.nodes.length} узл. / ${snapshot.edges.length} рёб.`);
    return true;
  }

  // Вырезает выделение: копирует в буфер и удаляет из графа (issue #230).
  function cutSelection(): void {
    if (!graph) return;
    if (!copySelection()) return;
    const next = removeGraphSelection(graph, selectedNodeIds, selectedEdgeIds);
    setGraph(next);
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
    setDirty(true);
  }

  // Вставляет буфер со сдвигом и выделяет вставленные узлы (issue #230).
  function pasteClipboard(): void {
    if (!graph || !clipboardHasContent(clipboard) || !clipboard) return;
    const result = pasteGraphClipboard(graph, clipboard);
    if (result.nodeIds.length === 0) return;
    setGraph(result.graph);
    setSelectedNodeIds(result.nodeIds);
    setSelectedEdgeIds([]);
    setDirty(true);
    setError('');
  }

  // Дублирует выделение вместе с рёбрами между узлами (issue #230).
  function duplicateSelection(): void {
    if (!graph || !selectedNodeIds.length) return;
    const result = duplicateGraphNodes(graph, selectedNodeIds);
    if (result.nodeIds.length === 0) return;
    setGraph(result.graph);
    setSelectedNodeIds(result.nodeIds);
    setSelectedEdgeIds([]);
    setDirty(true);
  }

  function patchSelectedNode(patch: Partial<Pick<NodeDefinition, 'label' | 'config'>>): void {
    if (!graph || !selectedNode) return;
    setGraph(updateNodeConfig(graph, selectedNode.id, patch));
    setDirty(true);
  }

  // Спуск в bodyGraph узла (issue #337/#386): текущий граф запоминается как родитель
  // кадра, на канвас выводится сохранённое или новое тело.
  function openBodyGraph(nodeId: string): void {
    if (!graph) return;
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || (node.type !== 'loop' && node.type !== 'graph_rag')) return;
    const nodeType = node.type === 'graph_rag' ? 'graph_rag' : 'loop';
    const body = getBodyGraph(graph, nodeId);
    setLoopStack((prev) => [...prev, { parentGraph: graph, loopNodeId: nodeId, nodeType }]);
    setGraph(body);
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
    setFailedNodeId(null);
    setError('');
    setNotice('');
  }

  // Двойной клик по узлу (issue #395): узлы с внутренней схемой (loop, graph_rag)
  // открываются на канвасе так же, как кнопка «Открыть» в панели узла. Для остальных
  // типов openBodyGraph ничего не делает — проверка типа внутри неё.
  function handleNodeDoubleClick(_event: ReactMouseEvent, node: SchemaFlowNode): void {
    openBodyGraph(node.id);
  }

  // Выход из bodyGraph на уровень выше (issue #337/#386): тело записывается в config.bodyGraph
  // родителя и редактор поднимается на предыдущий уровень. dirty выставляем только когда
  // тело действительно изменилось — простое открытие/закрытие не создаёт правок.
  function exitLoop(): void {
    if (!graph || loopStack.length === 0) return;
    const frame = loopStack[loopStack.length - 1];
    const nodeType = frame.nodeType ?? 'loop';
    const parentNode = frame.parentGraph.nodes.find((node) => node.id === frame.loopNodeId);
    const stored = parentNode ? parentNode.config.bodyGraph : undefined;
    const baseline = stored ?? makeEmptyBodyGraph(frame.parentGraph, frame.loopNodeId, nodeType);
    const changed = JSON.stringify(baseline) !== JSON.stringify(graph);
    const parent =
      stored === undefined && !changed
        ? frame.parentGraph
        : writeBodyGraph(frame.parentGraph, frame.loopNodeId, graph);
    setLoopStack((prev) => prev.slice(0, -1));
    setGraph(parent);
    setSelectedNodeIds([frame.loopNodeId]);
    setSelectedEdgeIds([]);
    setFailedNodeId(null);
    if (changed) setDirty(true);
  }

  // Применяет сохранённый сервером граф к редактору на месте (issue #393): если до
  // сохранения была открыта схема узла (тело цикла/graph_rag), восстанавливаем тот же
  // путь на свежем корневом графе и остаёмся в нём — без полной перезагрузки редактора,
  // которая сбрасывала бы позицию камеры и закрывала открытую схему узла.
  function applySavedGraph(savedRoot: SchemaGraph): void {
    const root = { ...savedRoot, slug: activeSlug };
    if (loopStack.length === 0) {
      setLoopStack([]);
      setGraph(root);
      return;
    }
    const { frames, leaf } = reopenBodyGraphFrames(root, loopStack);
    setLoopStack(frames);
    setGraph(leaf);
  }

  // Сохраняет схему (issue #286, #310). Для существующей схемы: записываем черновик и
  // промоутим его в рабочую версию. Для ещё не созданной (нет строки в БД, например
  // новая суб-схема) черновик-эндпоинт недоступен — создаём строку напрямую через
  // PATCH /api/schemas/:slug, где вид (тип/класс) сервер выводит из самого графа.
  async function saveSchema(): Promise<void> {
    if (!graph) return;
    // На сервер всегда уходит целая схема: если открыто тело цикла, сворачиваем стек
    // в корневой граф (issue #337).
    const payloadGraph = applyGraphKind(collapseBodyGraphFrames(loopStack, graph));
    try {
      if (!schemaPersisted) {
        const created = await apiFetch<ApiRecord>(token, `/api/schemas/${activeSlug}`, {
          method: 'PATCH',
          body: JSON.stringify({
            graphJson: payloadGraph,
            gameId: requestGameId,
            description,
          }),
        });
        applySavedGraph(normalizeSchemaGraph(created.graph_json));
        setDescription(field(created, 'description'));
        setDirty(false);
        setHasDraft(false);
        setSchemaPersisted(true);
        setFailedNodeId(null);
        setPendingSubSchema(null);
        setNotice('Схема создана.');
        setError('');
        setListRefresh((value) => value + 1);
        return;
      }
      // Сначала сохраняем текущий редактор как черновик, потом промоутим.
      if (dirty) {
        await apiFetch<ApiRecord>(token, `/api/schemas/${activeSlug}/draft${gameQuery}`, {
          method: 'PATCH',
          body: JSON.stringify({
            graphJson: payloadGraph,
            gameId: requestGameId,
          }),
        });
      }
      const promoted = await apiFetch<ApiRecord>(token, `/api/schemas/${activeSlug}/promote${gameQuery}`, {
        method: 'POST',
      });
      applySavedGraph(normalizeSchemaGraph(promoted.graph_json));
      setDescription(field(promoted, 'description'));
      setDirty(false);
      setHasDraft(false);
      setFailedNodeId(null);
      setNotice('Схема сохранена.');
      setError('');
      setListRefresh((value) => value + 1);
    } catch (err) {
      setNotice('');
      setError(err instanceof Error ? err.message : 'Не удалось сохранить схему');
    }
  }

  // Сбрасывает черновик до рабочей версии (кнопка «Обновить», issue #286): обнуляет
  // draft_graph_json на сервере (DELETE), после чего перезагружает редактор — он
  // покажет актуальную рабочую версию. Незафиксированные правки черновика теряются.
  async function refreshDraft(): Promise<void> {
    if (!window.confirm('Обновить черновик из рабочей версии? Все незафиксированные изменения в черновике будут потеряны.')) return;
    try {
      await apiFetch<ApiRecord>(token, `/api/schemas/${activeSlug}/draft${gameQuery}`, {
        method: 'DELETE',
      });
      setDirty(false);
      setHasDraft(false);
      setError('');
      setRefresh((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось обновить черновик');
    }
  }

  function exportSchema(): void {
    if (!graph) return;
    // Экспортируем целую схему даже из тела открытого цикла (issue #337).
    const root = collapseBodyGraphFrames(loopStack, graph);
    downloadJsonFile(`tg-games-schema-${activeSlug}-${requestGameId ?? 'base'}-${fileTimestamp()}.json`, {
      version: 1,
      exportedAt: new Date().toISOString(),
      items: [
        {
          schemaSlug: activeSlug,
          schemaType: graphPaletteKind(root) ?? '',
          gameId: requestGameId,
          graphJson: applyGraphKind(root),
          description,
        },
      ],
    });
    setNotice('JSON-файл схемы подготовлен.');
  }

  async function importSchema(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !graph) return;
    try {
      const payload = JSON.parse(await file.text()) as unknown;
      const preview = extractImportPreview(payload, activeSlug, graph, description);
      setImportPreview(preview);
      setError('');
    } catch (err) {
      setImportPreview(null);
      setError(err instanceof Error ? err.message : 'Не удалось прочитать JSON-файл');
    }
  }

  function applyImportPreview(): void {
    if (!importPreview) return;
    setGraph(importPreview.graph);
    setDescription(importPreview.description);
    setDirty(true);
    setNotice(importPreview.summary);
    setImportPreview(null);
  }

  // Глобальный экспорт всех схем (issue #248): скачиваем бандл с сервера как есть.
  async function exportAllSchemas(): Promise<void> {
    setBundleBusy(true);
    try {
      const bundle = await apiFetch<unknown>(token, '/api/schemas/export');
      downloadJsonFile(`tg-games-schemas-${fileTimestamp()}.json`, bundle);
      setNotice('JSON-файл со всеми схемами подготовлен.');
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось выгрузить схемы');
    } finally {
      setBundleBusy(false);
    }
  }

  // Глобальный импорт бандла (issue #248): разбираем файл, сверяем с текущим состоянием
  // сервера (через /api/schemas/export) и показываем клиентский diff до применения.
  async function importAllSchemas(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    setBundleBusy(true);
    try {
      const payload = JSON.parse(await file.text()) as unknown;
      const items = parseSchemaBundle(payload);
      const current = await apiFetch<unknown>(token, '/api/schemas/export');
      const existing = parseSchemaBundle(current).map<ExistingSchema>((schema) => ({
        schemaSlug: schema.schemaSlug,
        gameId: schema.gameId,
        graphJson: schema.graphJson,
        description: schema.description,
      }));
      const diff = diffSchemaBundle(items, existing);
      setBundlePreview({ items, diff });
      setError('');
    } catch (err) {
      setBundlePreview(null);
      setError(err instanceof Error ? err.message : 'Не удалось прочитать бандл схем');
    } finally {
      setBundleBusy(false);
    }
  }

  // Применяем глобальный импорт: сервер возвращает авторитетную сводку (issue #248).
  async function applyBundleImport(): Promise<void> {
    if (!bundlePreview) return;
    setBundleBusy(true);
    try {
      const summary = await apiFetch<ImportSummary>(token, '/api/schemas/import', {
        method: 'POST',
        body: JSON.stringify({ items: bundlePreview.items }),
      });
      setBundlePreview(null);
      setNotice(`Импорт схем выполнен — ${formatImportSummary(summary)}. Нажмите «Обновить», чтобы перезагрузить активную схему.`);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось импортировать схемы');
    } finally {
      setBundleBusy(false);
    }
  }

  async function openHistory(): Promise<void> {
    try {
      const history = await apiFetch<{ items: ApiRecord[] }>(token, `/api/schemas/${activeSlug}/history${gameQuery}`);
      const storageKey = `history-seen-${activeSlug}`;
      const prev = localStorage.getItem(storageKey);
      localStorage.setItem(storageKey, new Date().toISOString());
      setHistoryNewSince(prev);
      setHistoryRows(history.items);
      setHistoryPreview(null);
      setHistoryOpen(true);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить историю схемы');
    }
  }

  async function previewHistoryEntry(historyId: string): Promise<void> {
    try {
      const entry = await apiFetch<ApiRecord>(token, `/api/schemas/${activeSlug}/history/${historyId}`);
      setHistoryPreview(entry);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить версию схемы');
    }
  }

  async function restoreHistoryEntry(historyId: string): Promise<void> {
    if ((dirty || hasDraft) && !window.confirm('Черновик будет заменён восстановленной версией. Продолжить?')) return;
    try {
      const restored = await apiFetch<ApiRecord>(token, `/api/schemas/${activeSlug}/restore/${historyId}`, {
        method: 'POST',
      });
      setGraph(normalizeSchemaGraph(restored.graph_json));
      setDescription(field(restored, 'description'));
      setDirty(false);
      setHasDraft(false);
      setHistoryOpen(false);
      setNotice('Версия из истории восстановлена.');
      setRefresh((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось восстановить версию');
    }
  }

  // Изолированный тест тела узла (issue #390): когда редактор находится внутри
  // тела узла (loop/graph_rag), тест должен прогонять только это тело. Путь к узлу
  // — id всех узлов по стеку входов, а форма входов строится по портам самого
  // тестируемого (внутреннего) узла, а не по граничным портам его start-узла.
  const bodyTestInfo = useMemo((): BodyTestInfo | null => {
    if (loopStack.length === 0) return null;
    const innermost = loopStack[loopStack.length - 1];
    const node = innermost.parentGraph.nodes.find((candidate) => candidate.id === innermost.loopNodeId);
    if (!node) return null;
    return {
      nodePath: loopStack.map((frame) => frame.loopNodeId),
      node,
      parentGraph: innermost.parentGraph,
    };
  }, [loopStack]);

  async function deleteHistoryEntry(historyId: string): Promise<void> {
    if (!window.confirm('Удалить эту версию из истории? Действие необратимо.')) return;
    try {
      await apiFetch<void>(token, `/api/schemas/${activeSlug}/history/${historyId}`, { method: 'DELETE' });
      setHistoryRows((rows) => rows.filter((row) => field(row, 'id') !== historyId));
      if (field(historyPreview, 'id') === historyId) setHistoryPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить версию');
    }
  }

  return (
    <section className="schemas-view">
      <div className="schemas-toolbar">
        <div className="schema-scope">
          <label className="schema-game-select" aria-label="Область схем">
            <select value={scopeValue} onChange={(event) => selectScope(event.target.value)}>
              <option value={SUPPORT_SCOPE_VALUE}>🛟 Поддержка</option>
              <option value={BASE_GAME_VALUE}>🌐 Базовая (для всех игр)</option>
              {SUB_SCHEMA_CLASSES.map((subClass) => {
                const records = subSchemas.filter((record) => field(record, 'schema_class') === subClass);
                if (records.length === 0) return null;
                return (
                  <optgroup key={subClass} label={`Суб-схемы · ${SUB_SCHEMA_CLASS_GROUP_LABEL[subClass]}`}>
                    {records.map((record) => {
                      const slug = field(record, 'schema_slug');
                      return (
                        <option key={slug} value={`${SUB_SCHEMA_SCOPE_PREFIX}${slug}`}>
                          🔀 {slug}
                        </option>
                      );
                    })}
                  </optgroup>
                );
              })}
              {games.length > 0 && (
                <optgroup label="Игры">
                  {games.map((game) => {
                    const id = field(game, 'game_id');
                    return (
                      <option key={id} value={id}>
                        🎮 {field(game, 'name') || id}
                      </option>
                    );
                  })}
                </optgroup>
              )}
            </select>
          </label>
          <div className="schema-tabs" role="tablist" aria-label="Типы схем">
            {visibleTabs.map((tab) => (
              <button
                key={tab.slug}
                className={activeSlug === tab.slug ? 'button button-active' : 'button'}
                type="button"
                onClick={() => selectSchema(tab.slug)}
              >
                {tab.label}
              </button>
            ))}
            {subSchemaMode && (
              <span className="button button-active" aria-current="page">
                🔀 {activeSlug}
              </span>
            )}
          </div>
        </div>
        <div className="schemas-actions">
          {graph && (
            <span
              className={`schema-draft-status${hasDraft || dirty ? ' schema-draft-status--has-draft' : ''}`}
              title={hasDraft || dirty ? 'Есть незафиксированный черновик' : 'Черновик совпадает с рабочей версией'}
              aria-label={hasDraft || dirty ? 'Есть незафиксированный черновик' : 'Черновик совпадает с рабочей версией'}
            >
              <CircleDot size={16} />
            </span>
          )}
          <ToolbarButton icon={RefreshCw} onClick={refreshDraft} iconOnly>Обновить</ToolbarButton>
          <ToolbarButton icon={Plus} onClick={() => setNewSubSlugOpen(true)} iconOnly>Создать sub-схему</ToolbarButton>
          <ToolbarButton icon={Save} onClick={saveSchema} disabled={!graph} iconOnly>Сохранить</ToolbarButton>
          <ToolbarButton icon={Download} onClick={exportSchema} disabled={!graph} iconOnly>Экспорт</ToolbarButton>
          <ToolbarButton icon={Upload} onClick={() => importInputRef.current?.click()} disabled={!graph} iconOnly>Импорт</ToolbarButton>
          <ToolbarButton icon={DownloadCloud} onClick={exportAllSchemas} disabled={bundleBusy} iconOnly>Экспорт всех</ToolbarButton>
          <ToolbarButton icon={UploadCloud} onClick={() => bundleInputRef.current?.click()} disabled={bundleBusy} iconOnly>Импорт бандла</ToolbarButton>
          <ToolbarButton icon={History} onClick={openHistory} disabled={!graph} iconOnly>История</ToolbarButton>
          <ToolbarButton icon={Play} onClick={() => void openTest()} disabled={!graph} iconOnly>Тест</ToolbarButton>
          <input
            ref={importInputRef}
            className="file-input"
            type="file"
            accept="application/json,.json"
            onChange={importSchema}
          />
          <input
            ref={bundleInputRef}
            className="file-input"
            type="file"
            accept="application/json,.json"
            onChange={importAllSchemas}
          />
        </div>
      </div>

      <ErrorLine message={error} />
      {loopStack.length > 0 && (
        <div className="schema-loop-path">
          <span className="schema-loop-path-label" title="Путь из идентификаторов открытых вложенных циклов">
            <CornerDownRight size={14} />
            {loopStack.map((frame) => frame.loopNodeId).join(' / ')}
          </span>
          <button
            className="button"
            type="button"
            onClick={exitLoop}
            title="Выйти из тела цикла на уровень выше"
          >
            Назад
          </button>
        </div>
      )}
      <MessageLine message={notice} />

      <div className="schemas-layout">
        <aside className="schema-palette panel">
          <div className="section-title">Схемы</div>
          <dl className="meta-list schema-meta-list">
            <dt>Область</dt>
            <dd>
              {supportMode
                ? 'Поддержка'
                : subSchemaMode
                  ? 'Sub-схемы'
                  : baseMode
                    ? 'Базовая (для всех игр)'
                    : field(games.find((game) => field(game, 'game_id') === gameId), 'name') || gameId}
            </dd>
            <dt>Активная</dt>
            <dd>{subSchemaMode ? activeSlug : schemaTypeLabel(activeSlug)}</dd>
            {subSchemaMode && (
              <>
                <dt>Класс</dt>
                <dd>{subSchemaClassLabel(activeSubSchemaClass)}</dd>
              </>
            )}
            <dt>Обновлена</dt>
            <dd>{schemaMeta ? formatDate(field(schemaMeta, 'updated_at')) : '—'}</dd>
            <dt>Состояние</dt>
            <dd>{dirty ? 'есть правки' : hasDraft ? 'черновик' : 'сохранено'}</dd>
          </dl>
          <label className="editor-label compact">
            Описание
            <input value={description} onChange={(event) => { setDescription(event.target.value); setDirty(true); }} />
          </label>
          <div className="subhead">Добавить узел</div>
          <div className="node-palette-hint">Перетащите узел на canvas</div>
          <div className="node-palette">
            {nodePalette.map((entry) => (
              <div
                className={`node-palette-button${entry.available ? '' : ' node-palette-button--disabled'}`}
                key={entry.type}
                role="button"
                tabIndex={entry.available ? 0 : -1}
                aria-disabled={entry.available ? undefined : true}
                title={entry.available ? undefined : entry.reason}
                draggable={entry.available}
                onDragStart={(event) => {
                  if (!entry.available) {
                    event.preventDefault();
                    return;
                  }
                  event.dataTransfer.setData(NODE_DND_MIME, entry.type);
                  event.dataTransfer.effectAllowed = 'copy';
                }}
              >
                <GripVertical size={14} />
                <span>{entry.label}</span>
                {!entry.available && <span className="node-palette-lock" aria-hidden="true">🔒</span>}
              </div>
            ))}
          </div>
          <div className="subhead">Выбор</div>
          <div className="node-palette-hint">
            Shift+рамка или Shift+клик — выделить несколько узлов
            {selectedNodeIds.length > 0 || selectedEdgeIds.length > 0
              ? ` · выбрано: ${selectedNodeIds.length} узл. / ${selectedEdgeIds.length} рёб.`
              : ''}
          </div>
          <div className="button-row">
            <ToolbarButton icon={Copy} onClick={copySelection} disabled={copyableSelectedCount === 0}>Копировать</ToolbarButton>
            <ToolbarButton icon={Scissors} onClick={cutSelection} disabled={copyableSelectedCount === 0}>Вырезать</ToolbarButton>
          </div>
          <div className="button-row">
            <ToolbarButton icon={ClipboardPaste} onClick={pasteClipboard} disabled={!clipboardHasContent(clipboard)}>Вставить</ToolbarButton>
            <ToolbarButton icon={Copy} onClick={duplicateSelection} disabled={copyableSelectedCount === 0}>Дублировать</ToolbarButton>
          </div>
          <div className="button-row">
            <ToolbarButton icon={Trash2} onClick={deleteSelection} disabled={selectedNodeIds.length === 0 && selectedEdgeIds.length === 0}>Удалить</ToolbarButton>
          </div>
        </aside>

        <div className="schema-canvas panel">
          {loading && <EmptyState>Загрузка схемы…</EmptyState>}
          {!loading && !graph && <EmptyState>Схема не загружена.</EmptyState>}
          {!loading && graph && (
            <ErrorBoundary scope="Редактор схем">
              <ReactFlowProvider>
                <NodeDropZone onAddNode={addNodeAtPosition}>
                  <ReactFlow
                    nodes={flowNodes}
                    edges={flowEdges}
                    nodeTypes={schemaNodeTypes}
                    onNodesChange={handleNodesChange}
                    onEdgesChange={handleEdgesChange}
                    onConnect={handleConnect}
                    isValidConnection={isValidConnection}
                    onSelectionChange={handleSelectionChange}
                    onSelectionStart={handleSelectionStart}
                    onSelectionEnd={handleSelectionEnd}
                    onPaneClick={handlePaneClick}
                    onNodeDoubleClick={handleNodeDoubleClick}
                    onNodeContextMenu={handleNodeContextMenu}
                    onEdgeContextMenu={handleEdgeContextMenu}
                    onPaneContextMenu={handlePaneContextMenu}
                    fitView
                    minZoom={0.2}
                    // Множественное выделение (issue #230): Shift добавляет узлы по клику
                    // и включает рамочное выделение перетаскиванием по пустому полотну.
                    multiSelectionKeyCode="Shift"
                    selectionKeyCode="Shift"
                    // Удалением выделения управляем сами (issue #211): Backspace не удаляет
                    // блок никогда, Delete — только когда фокус не в поле ввода текста.
                    deleteKeyCode={null}
                  >
                    <Background gap={18} size={1} />
                    <MiniMap pannable zoomable />
                    <Controls />
                  </ReactFlow>
                </NodeDropZone>
                <FlowFocusController
                  focusNodeId={pendingFocusNodeId}
                  onFocused={(nodeId) => {
                    setPendingFocusNodeId(null);
                    // Выделяем сфокусированный узел после fitView (issue #288, #303).
                    if (nodeId) setSelectedNodeIds([nodeId]);
                  }}
                />
              </ReactFlowProvider>
            </ErrorBoundary>
          )}
          {contextMenu && (
            <ContextMenu
              menu={contextMenu}
              canPaste={clipboardHasContent(clipboard)}
              hasSelection={selectedNodeIds.length > 0}
              onCopy={() => {
                copySelection();
                closeContextMenu();
              }}
              onCut={() => {
                cutSelection();
                closeContextMenu();
              }}
              onDuplicate={() => {
                duplicateSelection();
                closeContextMenu();
              }}
              onPaste={() => {
                pasteClipboard();
                closeContextMenu();
              }}
              onDeleteNodes={() => {
                deleteSelection();
                closeContextMenu();
              }}
              onDeleteEdge={() => {
                deleteSelectedEdges();
                closeContextMenu();
              }}
            />
          )}
        </div>

        <aside className="schema-config panel">
          {selectedNodes.length === 0 && selectedEdges.length === 0 && (
            <EmptyState>Выберите ноду или ребро на canvas.</EmptyState>
          )}
          {selectedNode && (
            <NodeConfigPanel
              node={selectedNode}
              graph={graph}
              subSchemaOptions={subSchemaOptions}
              onPatch={patchSelectedNode}
              onFocusNode={(nodeId) => setPendingFocusNodeId(nodeId)}
              onOpenLoop={openBodyGraph}
            />
          )}
          {selectedNodes.length > 1 && (
            <SelectionConfigPanel
              nodes={selectedNodes}
              edgeCount={selectedEdges.length}
              onCopy={copySelection}
              onCut={cutSelection}
              onDuplicate={duplicateSelection}
              onDelete={deleteSelection}
            />
          )}
          {selectedNodes.length === 0 && selectedEdges.length > 0 && (
            <EdgeConfigPanel
              edges={selectedEdges}
              onDelete={deleteSelectedEdges}
            />
          )}
        </aside>
      </div>

      {historyOpen && (
        <Modal title={`История схемы ${activeSlug}`} onClose={() => setHistoryOpen(false)}>
          {historyRows.length === 0 && <EmptyState>История пока пуста.</EmptyState>}
          {historyRows.length > 0 && (
            <table className="history-table">
              <thead>
                <tr>
                  <th className="history-new-col"></th>
                  <th className="history-date-col">Архив</th>
                  <th className="history-date-col">Версия</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {historyRows.map((row) => {
                  const archivedAt = field(row, 'archived_at');
                  const isNew = historyNewSince !== null && archivedAt > historyNewSince;
                  return (
                    <tr key={field(row, 'id')}>
                      <td className="history-new-col">
                        {isNew && <span className="history-new-dot" title="Новая запись" aria-label="Новая запись" />}
                      </td>
                      <td className="history-date-col">{formatDate(archivedAt)}</td>
                      <td className="history-date-col">{formatDate(field(row, 'version_created_at'))}</td>
                      <td>
                        <div className="history-actions">
                          <button className="button" type="button" onClick={() => previewHistoryEntry(field(row, 'id'))}>
                            Просмотр
                          </button>
                          <button className="button" type="button" onClick={() => restoreHistoryEntry(field(row, 'id'))}>
                            Восстановить
                          </button>
                          <button className="button button-danger" type="button" onClick={() => deleteHistoryEntry(field(row, 'id'))}>
                            Удалить
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {historyPreview && (
            <>
              <div className="subhead">Graph JSON</div>
              <pre className="json-box">{jsonPreview(historyPreview.graph_json)}</pre>
            </>
          )}
        </Modal>
      )}

      {importPreview && (
        <Modal title="Импорт схемы" onClose={() => setImportPreview(null)}>
          <MessageLine message={importPreview.summary} />
          <div className="button-row">
            <ToolbarButton icon={Upload} onClick={applyImportPreview}>Применить импорт</ToolbarButton>
          </div>
          <pre className="json-box">{jsonPreview(importPreview.graph)}</pre>
        </Modal>
      )}

      {bundlePreview && (
        <Modal title="Импорт бандла схем" onClose={() => setBundlePreview(null)}>
          <p className="hint">
            Предпросмотр на стороне клиента; авторитетную сводку вернёт сервер после применения.
          </p>
          <MessageLine message={formatImportSummary(bundlePreview.diff)} />
          <table className="data-table">
            <thead>
              <tr>
                <th>Слаг</th>
                <th>Игра</th>
                <th>Действие</th>
              </tr>
            </thead>
            <tbody>
              {bundlePreview.diff.rows.map((row, index) => (
                <tr key={`${row.slug}-${row.gameId ?? ''}-${index}`}>
                  <td>{row.slug || '—'}</td>
                  <td>{row.gameId ?? 'базовая'}</td>
                  <td>
                    <span className={`bundle-action bundle-action--${row.action}`}>
                      {row.action === 'created' ? 'создать' : row.action === 'updated' ? 'обновить' : 'без изменений'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="button-row">
            <ToolbarButton icon={UploadCloud} onClick={applyBundleImport} disabled={bundleBusy}>
              {bundleBusy ? 'Импорт…' : 'Применить импорт'}
            </ToolbarButton>
          </div>
        </Modal>
      )}

      {testOpen && graph && (
        <SchemaTestModal
          token={token}
          slug={activeSlug}
          schemaType={activePaletteKind}
          graph={graph}
          bodyTest={bodyTestInfo}
          defaultGameId={requestGameId}
          games={games}
          onClose={() => setTestOpen(false)}
          onFailedNode={setFailedNodeId}
          onSelectNode={(nodeId) => setSelectedNodeIds(nodeId ? [nodeId] : [])}
        />
      )}

      {newSubSlugOpen && (
        <NewSubSchemaModal
          onClose={() => setNewSubSlugOpen(false)}
          onConfirm={(slug, newClass) => {
            setNewSubSlugOpen(false);
            if (dirty && !window.confirm('Есть несохранённые изменения. Перейти к новой схеме?')) return;
            // Запоминаем класс будущей суб-схемы (строки в БД ещё нет, issue #310): по нему
            // load-эффект построит пустой граф нужного класса до первого сохранения.
            setPendingSubSchema({ slug, subSchemaClass: newClass, gameId: null });
            onNavigate(slug, null);
          }}
        />
      )}
    </section>
  );
}

function BlueprintNode({ data, selected }: NodeProps<SchemaFlowNode>) {
  const node = data.graphNode;
  const ports = getNodePorts(node, data.graph);
  // Сигнатура портов: id+тип каждого входа/выхода. При смене состава портов
  // (добавление/переименование выхода variable_read, входа variable_write и т.п.)
  // ReactFlow не перемеряет позиции хэндлов, если габариты узла не изменились —
  // новый хэндл остаётся незарегистрированным, и из него нельзя начать ребро, а
  // существующие рёбра к нему не отрисовываются (issue #394). Поэтому при изменении
  // сигнатуры явно просим ReactFlow обновить внутренние данные узла.
  const portSignature = [...ports.inputs, ...ports.outputs]
    .map((port) => `${port.direction}:${port.id}:${port.type}`)
    .join('|');
  const updateNodeInternals = useUpdateNodeInternals();
  // На первом рендере ReactFlow сам измеряет узел и хэндлы, поэтому принудительный
  // вызов не нужен (и даже вреден: он временно сбрасывает измеренные габариты, что
  // ломает рамочное выделение по нескольким узлам). Зовём updateNodeInternals только
  // когда сигнатура портов реально изменилась относительно предыдущего рендера.
  const prevPortSignatureRef = useRef(portSignature);
  useEffect(() => {
    if (prevPortSignatureRef.current === portSignature) return;
    prevPortSignatureRef.current = portSignature;
    updateNodeInternals(node.id);
  }, [node.id, portSignature, updateNodeInternals]);
  const failed = data.failedNodeId === node.id;
  const removable = node.type !== 'start' && node.type !== 'end';
  // Визуальное оформление (issue #248, ТЗ §5): цвет шапки по категории узла,
  // ромбовидная форма для граничных start/end.
  const category = nodeCategory(node.type);
  const boundary = node.type === 'start' || node.type === 'end';
  return (
    <div
      className={`blueprint-node blueprint-node--${category} ${boundary ? `blueprint-node--${node.type}` : ''} ${selected ? 'selected' : ''} ${failed ? 'failed' : ''}`}
    >
      <div className={`blueprint-node-head blueprint-node-head--${category}`}>
        <div className="blueprint-node-title">
          <span>{node.label || NODE_TYPE_LABELS[node.type]}</span>
          <code>{node.type}</code>
        </div>
        {removable && (
          <button
            className="blueprint-node-delete nodrag nopan"
            type="button"
            title="Удалить блок"
            aria-label="Удалить блок"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              data.onDeleteNode(node.id);
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>
      <div className="blueprint-node-body">{formatConfigSummary(node)}</div>
      <div className="blueprint-port-grid">
        <NodePorts ports={ports.inputs} side="input" />
        <NodePorts ports={ports.outputs} side="output" />
      </div>
    </div>
  );
}

function EdgeConfigPanel({
  edges,
  onDelete,
}: {
  edges: EdgeDefinition[];
  onDelete: () => void;
}) {
  const edge = edges[0];
  const title = edges.length === 1 ? 'Ребро' : `Рёбра · ${edges.length}`;

  return (
    <div>
      <div className="section-title">{title}</div>
      {edges.length === 1 && edge && (
        <dl className="meta-list">
          <dt>ID</dt>
          <dd>{edge.id}</dd>
          <dt>Из</dt>
          <dd>{edge.from}.{edge.fromPort}</dd>
          <dt>В</dt>
          <dd>{edge.to}.{edge.toPort}</dd>
          <dt>Тип</dt>
          <dd>{isExecPortId(edge.fromPort) ? 'exec' : 'data'}</dd>
        </dl>
      )}
      {edges.length > 1 && (
        <div className="schema-edge-list">
          {edges.map((item) => (
            <div className="schema-edge-row" key={item.id}>
              <code>{item.from}.{item.fromPort}</code>
              <span>→</span>
              <code>{item.to}.{item.toPort}</code>
            </div>
          ))}
        </div>
      )}
      <div className="button-row">
        <ToolbarButton icon={Trash2} onClick={onDelete}>
          {edges.length === 1 ? 'Удалить ребро' : 'Удалить рёбра'}
        </ToolbarButton>
      </div>
    </div>
  );
}

// Панель массовых операций над несколькими выбранными узлами (issue #230).
function SelectionConfigPanel({
  nodes,
  edgeCount,
  onCopy,
  onCut,
  onDuplicate,
  onDelete,
}: {
  nodes: NodeDefinition[];
  edgeCount: number;
  onCopy: () => void;
  onCut: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const copyable = nodes.filter((node) => isCopyableNode(node)).length;
  return (
    <div>
      <div className="section-title">Выбрано узлов · {nodes.length}</div>
      <dl className="meta-list">
        <dt>Можно копировать</dt>
        <dd>{copyable}</dd>
        <dt>Рёбра выделения</dt>
        <dd>{edgeCount}</dd>
      </dl>
      <div className="schema-edge-list">
        {nodes.map((node) => (
          <div className="schema-edge-row" key={node.id}>
            <code>{node.id}</code>
            <span>·</span>
            <code>{node.type}</code>
          </div>
        ))}
      </div>
      <div className="button-row">
        <ToolbarButton icon={Copy} onClick={onCopy} disabled={copyable === 0}>Копировать</ToolbarButton>
        <ToolbarButton icon={Scissors} onClick={onCut} disabled={copyable === 0}>Вырезать</ToolbarButton>
      </div>
      <div className="button-row">
        <ToolbarButton icon={Copy} onClick={onDuplicate} disabled={copyable === 0}>Дублировать</ToolbarButton>
        <ToolbarButton icon={Trash2} onClick={onDelete}>Удалить</ToolbarButton>
      </div>
    </div>
  );
}

function NodePorts({ ports, side }: { ports: PortDefinition[]; side: 'input' | 'output' }) {
  return (
    <div className={`blueprint-ports ${side}`}>
      {ports.map((port) => {
        const handle = (
          <Handle
            type={side === 'input' ? 'target' : 'source'}
            id={port.id}
            position={side === 'input' ? Position.Left : Position.Right}
            className="blueprint-handle"
            style={{ background: portColor(port.type), borderColor: portColor(port.type) }}
          />
        );
        const label = <span className="blueprint-port-label">{port.label}</span>;
        return (
          <div className="blueprint-port-row" key={port.id}>
            {side === 'input' ? handle : label}
            {side === 'input' ? label : handle}
          </div>
        );
      })}
    </div>
  );
}

function NodeConfigPanel({
  node,
  graph,
  subSchemaOptions,
  onPatch,
  onFocusNode,
  onOpenLoop,
}: {
  node: NodeDefinition;
  graph: SchemaGraph | null;
  subSchemaOptions: SubSchemaOption[];
  onPatch: (patch: Partial<Pick<NodeDefinition, 'label' | 'config'>>) => void;
  onFocusNode?: (nodeId: string) => void;
  onOpenLoop?: (nodeId: string) => void;
}) {
  const config = node.config;
  const setConfig = (next: Record<string, unknown>) => onPatch({ config: next });
  const setConfigKey = (key: string, value: unknown) => setConfig({ ...config, [key]: value });
  const ports = graph ? getNodePorts(node, graph) : { inputs: [], outputs: [] };
  // Имена входящих портов данных (без exec-портов) — для панели вставки в раскрытом
  // редакторе текста (issue #285).
  const dataInputNames = ports.inputs.filter((port) => !isExecPortId(port.id)).map((port) => port.id);
  const hasBodyGraph = node.type === 'loop' || node.type === 'graph_rag';
  const bodyGraphTitle = node.type === 'graph_rag'
    ? 'Открыть graph_rag bodyGraph на канвасе'
    : 'Открыть тело цикла на канвасе';

  return (
    <div>
      <div className="section-title node-config-title">
        <span>{node.label || NODE_TYPE_LABELS[node.type]}</span>
        {onFocusNode && (
          <button
            className="icon-button"
            type="button"
            title="Приблизить и центрировать узел на схеме"
            aria-label="Приблизить узел"
            onClick={() => onFocusNode(node.id)}
          >
            <Locate size={15} />
          </button>
        )}
      </div>
      {hasBodyGraph && onOpenLoop && (
        <button
          className="button node-loop-open"
          type="button"
          onClick={() => onOpenLoop(node.id)}
          title={bodyGraphTitle}
        >
          <CornerDownRight size={15} />
          Открыть
        </button>
      )}
      <dl className="meta-list">
        <dt>ID</dt>
        <dd>{node.id}</dd>
        <dt>Тип</dt>
        <dd>{node.type}</dd>
      </dl>
      <label className="editor-label compact">
        Label
        <input value={node.label ?? ''} onChange={(event) => onPatch({ label: event.target.value })} />
      </label>
      <label className="editor-label compact">
        Comment
        <textarea
          value={typeof config.comment === 'string' ? config.comment : ''}
          onChange={(event) => setConfigKey('comment', event.target.value)}
          rows={3}
        />
      </label>
      <NodeSpecificConfig
        node={node}
        graph={graph}
        setConfig={setConfig}
        setConfigKey={setConfigKey}
        subSchemaOptions={subSchemaOptions}
        inputPorts={dataInputNames}
      />
      <div className="subhead">Порты</div>
      <div className="schema-port-list">
        {[...ports.inputs, ...ports.outputs].map((port) => (
          <span className="schema-port-pill" key={`${port.direction}:${port.id}`}>
            <span style={{ background: portColor(port.type) }} />
            {port.direction === 'input' ? 'in' : 'out'} · {port.id} · {port.type}
          </span>
        ))}
      </div>
    </div>
  );
}

function NodeSpecificConfig({
  node,
  graph,
  setConfig,
  setConfigKey,
  subSchemaOptions,
  inputPorts,
}: {
  node: NodeDefinition;
  graph: SchemaGraph | null;
  setConfig: (next: Record<string, unknown>) => void;
  setConfigKey: (key: string, value: unknown) => void;
  subSchemaOptions: SubSchemaOption[];
  inputPorts: string[];
}) {
  const config = node.config;
  // Граничные порты start/end суб-схемы редактируются прямо в узле (issue #310):
  // start хранит входы суб-схемы в config.outputs, end — её выходы в config.inputs.
  // Для пайплайн-схемы порты фиксированы по типу и не редактируются.
  if ((node.type === 'start' || node.type === 'end') && graph && isSubSchemaGraph(graph)) {
    const boundaryKey = node.type === 'start' ? 'outputs' : 'inputs';
    return (
      <>
        <p className="editor-hint">
          {node.type === 'start'
            ? 'Входы суб-схемы: каждый порт становится входом узла sub_schema, который её вызывает.'
            : 'Выходы суб-схемы: каждый порт становится выходом узла sub_schema, который её вызывает.'}
        </p>
        <BoundaryPortsEditor
          label={node.type === 'start' ? 'Входы' : 'Выходы'}
          value={config[boundaryKey]}
          onChange={(value) => setConfigKey(boundaryKey, value)}
        />
      </>
    );
  }
  if (node.type === 'llm_request') {
    return (
      <>
        <label className="editor-label compact">
          <ExpandableTextarea
            title="System prompt"
            value={asString(config.systemPrompt)}
            onChange={(value) => setConfigKey('systemPrompt', value)}
            ports={inputPorts}
            insertMode="template"
            rows={6}
          />
        </label>
        <label className="editor-label compact">
          <ExpandableTextarea
            title="User prompt"
            value={asString(config.userPrompt)}
            onChange={(value) => setConfigKey('userPrompt', value)}
            ports={inputPorts}
            insertMode="template"
            rows={8}
          />
        </label>
        <label className="editor-label compact">
          <ExpandableTextarea
            title="Retry prompt"
            value={asString(config.retryPrompt)}
            onChange={(value) => setConfigKey('retryPrompt', value)}
            ports={inputPorts}
            insertMode="template"
            rows={4}
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.jsonMode !== false}
            onChange={(event) => setConfigKey('jsonMode', event.target.checked)}
          />
          <span>JSON-режим ответа</span>
        </label>
        <label className="editor-label compact">
          Retries
          <input
            type="number"
            min="1"
            max="10"
            placeholder="по умолчанию"
            value={typeof config.retries === 'number' ? config.retries : ''}
            onChange={(event) => {
              const next = Number(event.target.value);
              setConfigKey('retries', event.target.value === '' || next < 1 ? undefined : Math.floor(next));
            }}
          />
        </label>
        <p className="editor-hint">
          Сколько раз повторять запрос при невалидном ответе. Пусто — берётся глобальный лимит схемы.
        </p>
        <LlmModelOverride
          modelParams={isRecord(config.modelParams) ? config.modelParams : {}}
          onChange={(value) => setConfigKey('modelParams', value)}
        />
        <LlmPortsEditor
          label="Inputs"
          mode="inputs"
          value={config.inputs}
          onChange={(value) => setConfigKey('inputs', value)}
        />
        <LlmPortsEditor
          label="Outputs"
          mode="outputs"
          value={config.outputs}
          onChange={(value) => setConfigKey('outputs', value)}
        />
        <JsonEditor label="Model params (доп.)" value={isRecord(config.modelParams) ? config.modelParams : {}} onChange={(value) => setConfigKey('modelParams', value)} />
      </>
    );
  }
  if (node.type === 'condition') {
    return (
      <>
        <label className="editor-label compact">
          Input
          <input value={asString(config.input)} onChange={(event) => setConfigKey('input', event.target.value)} />
        </label>
        <label className="editor-label compact">
          Operator
          <select value={asString(config.operator) || 'truthy'} onChange={(event) => setConfigKey('operator', event.target.value)}>
            {CONDITION_OPERATORS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="editor-label compact">
          Right operand
          <input value={asString(config.right)} onChange={(event) => setConfigKey('right', event.target.value)} />
        </label>
      </>
    );
  }
  if (node.type === 'loop') {
    return <LoopConfig config={config} setConfigKey={setConfigKey} />;
  }
  if (node.type === 'graph_rag') {
    return (
      <label className="editor-label compact">
        Max iterations
        <input
          type="number"
          min="1"
          max="5"
          value={Number(config.maxIterations ?? 3)}
          onChange={(event) => setConfigKey('maxIterations', Number(event.target.value))}
        />
      </label>
    );
  }
  if (node.type === 'transform') {
    return (
      <>
        <label className="editor-label compact">
          <ExpandableTextarea
            title="Code"
            value={asString(config.code)}
            onChange={(value) => setConfigKey('code', value)}
            ports={inputPorts}
            insertMode="code"
            rows={8}
            spellCheck={false}
            placeholder="return input;"
          />
        </label>
        <p className="editor-hint">
          JS-код получает объект <code>input</code> с полями входов и должен вернуть значение через{' '}
          <code>return</code>. Выходы извлекаются по пути из <code>result</code>.
        </p>
        <LlmPortsEditor
          label="Inputs"
          mode="inputs"
          value={config.inputs}
          onChange={(value) => setConfigKey('inputs', value)}
        />
        <LlmPortsEditor
          label="Outputs"
          mode="outputs"
          value={config.outputs}
          onChange={(value) => setConfigKey('outputs', value)}
          pathKey="path"
          pathLabel="Path"
          pathPlaceholder="result"
        />
      </>
    );
  }
  if (node.type === 'sub_schema') {
    return <SubSchemaConfig config={config} setConfig={setConfig} subSchemaOptions={subSchemaOptions} />;
  }
  if (node.type === 'manifest') {
    return (
      <label className="editor-label compact">
        Fields
        <input
          value={stringArray(config.fields).join(', ')}
          onChange={(event) => setConfigKey('fields', splitComma(event.target.value))}
        />
      </label>
    );
  }
  if (node.type === 'game_state_read') {
    return (
      <p className="editor-hint">
        Узел без входов: на единственный выход <code>state</code> отдаётся текущий объект состояния игры.
      </p>
    );
  }
  if (node.type === 'game_state_write') {
    return (
      <p className="editor-hint">
        Узел без выходов: переданный на вход <code>state</code> объект мержится с текущим состоянием игры.
      </p>
    );
  }
  if (node.type === 'support_history_read') {
    return (
      <p className="editor-hint">
        Узел без входов: на выход <code>messages</code> отдаётся история переписки тикета —
        массив реплик <code>{'{ role, message }'}</code> в хронологическом порядке. Роли:
        <code>bot</code>, <code>operator</code>, <code>user</code> (в будущем добавится роль
        агента-пересказчика, см. docs/role-chronicler.md).
      </p>
    );
  }
  if (node.type === 'game_history_read') {
    return (
      <p className="editor-hint">
        Узел без входов: на выход <code>messages</code> отдаётся история ходов игры —
        массив реплик <code>{'{ role, message }'}</code>. Каждый ход разворачивается в действие
        игрока (<code>player</code>) и нарратив гейммастера (<code>master</code>); в будущем
        добавится роль агента-пересказчика, см. docs/role-chronicler.md.
      </p>
    );
  }
  if (node.type === 'variable_read') {
    return (
      <>
        <p className="editor-hint">
          Узел без входов: имя каждого выхода = имени переменной, значение которой отдаётся на этот выход.
        </p>
        <LlmPortsEditor
          label="Outputs"
          mode="outputs"
          value={config.outputs}
          onChange={(value) => setConfigKey('outputs', value)}
          showPath={false}
          addBaseName="variable"
        />
      </>
    );
  }
  if (node.type === 'variable_write') {
    return (
      <>
        <p className="editor-hint">
          Узел без выходов: имя каждого входа = имени переменной, в которую записывается значение этого входа.
        </p>
        <LlmPortsEditor
          label="Inputs"
          mode="inputs"
          value={config.inputs}
          onChange={(value) => setConfigKey('inputs', value)}
          addBaseName="variable"
        />
      </>
    );
  }
  if (node.type === 'media_generate') {
    return (
      <>
        <label className="editor-label compact">
          <ExpandableTextarea
            title="Prompt"
            value={asString(config.prompt)}
            onChange={(value) => setConfigKey('prompt', value)}
            ports={inputPorts}
            insertMode="template"
            rows={6}
          />
        </label>
        <p className="editor-hint">
          Настраиваемые входы как у llm_request: имя каждого входа доступно в шаблоне промпта как{' '}
          <code>{'{{name}}'}</code>. Единственный выход — <code>image_url</code>.
        </p>
        <LlmPortsEditor
          label="Inputs"
          mode="inputs"
          value={config.inputs}
          onChange={(value) => setConfigKey('inputs', value)}
        />
      </>
    );
  }
  if (node.type === 'log') {
    return (
      <label className="editor-label compact">
        Message
        <input value={asString(config.message)} onChange={(event) => setConfigKey('message', event.target.value)} />
      </label>
    );
  }
  if (node.type === 'constant') {
    return <ConstantPortsEditor value={config.outputs} onChange={(value) => setConfigKey('outputs', value)} />;
  }
  return null;
}

// Структурированные поля переопределения провайдера/модели llm_request (issue #248).
// Значения кладутся в modelParams (provider/model) и попадают в аудит запроса; раздел
// заменяет необходимость править эти ключи вручную через JSON-редактор Model params.
function LlmModelOverride({
  modelParams,
  onChange,
}: {
  modelParams: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
}) {
  const setKey = (key: string, value: string) => {
    const next = { ...modelParams };
    if (value.trim() === '') delete next[key];
    else next[key] = value;
    onChange(next);
  };
  return (
    <>
      <label className="editor-label compact">
        Provider override
        <input
          value={asString(modelParams.provider)}
          placeholder="например, openai"
          onChange={(event) => setKey('provider', event.target.value)}
        />
      </label>
      <label className="editor-label compact">
        Model override
        <input
          value={asString(modelParams.model)}
          placeholder="например, gpt-4o-mini"
          onChange={(event) => setKey('model', event.target.value)}
        />
      </label>
      <p className="editor-hint">
        Провайдер и модель записываются в параметры запроса и сохраняются в аудите LLM.
      </p>
    </>
  );
}

// Конфиг loop с переключателем режима выхода (issue #248): «по счётчику» или
// «по выражению». Режим — локальное состояние, т. к. при пустом exitExpression его
// нельзя вывести из конфига; при выборе «по счётчику» выражение очищается, чтобы
// движок завершал цикл строго по maxIterations.
function LoopConfig({
  config,
  setConfigKey,
}: {
  config: Record<string, unknown>;
  setConfigKey: (key: string, value: unknown) => void;
}) {
  const [mode, setMode] = useState<LoopMode>(() => loopModeFromConfig(config));
  const selectMode = (next: LoopMode) => {
    setMode(next);
    if (next === 'count') setConfigKey('exitExpression', '');
  };
  return (
    <>
      <div className="editor-label compact">
        Режим выхода
        <div className="segmented">
          <label className={`segmented-option${mode === 'count' ? ' is-active' : ''}`}>
            <input
              type="radio"
              name={`loop-mode-${config.comment ?? ''}`}
              checked={mode === 'count'}
              onChange={() => selectMode('count')}
            />
            По счётчику
          </label>
          <label className={`segmented-option${mode === 'expression' ? ' is-active' : ''}`}>
            <input
              type="radio"
              name={`loop-mode-${config.comment ?? ''}`}
              checked={mode === 'expression'}
              onChange={() => selectMode('expression')}
            />
            По выражению
          </label>
        </div>
      </div>
      <label className="editor-label compact">
        Max iterations
        <input
          type="number"
          min="1"
          max="100"
          value={Number(config.maxIterations ?? 1)}
          onChange={(event) => setConfigKey('maxIterations', Number(event.target.value))}
        />
      </label>
      {mode === 'expression' && (
        <label className="editor-label compact">
          Exit expression
          <input
            value={asString(config.exitExpression)}
            onChange={(event) => setConfigKey('exitExpression', event.target.value)}
            placeholder="state.done === true"
          />
        </label>
      )}
      <p className="editor-hint">
        {mode === 'count'
          ? 'Цикл выполняет тело ровно столько раз, сколько задано в Max iterations.'
          : 'Цикл прерывается, как только выражение станет истинным; Max iterations ограничивает число итераций сверху.'}
      </p>
      <p className="editor-hint">
        Тело цикла редактируется на канвасе: нажмите «Открыть» в шапке панели узла (issue #337).
      </p>
    </>
  );
}

// Конфиг sub_schema с выбором суб-схемы из списка (issue #248, #310): администратор
// выбирает существующую суб-схему (по классу и slug); при выборе сохраняется снимок её
// граничных портов в config.ports — контракт не резолвит slug сам и берёт порты узла
// из этого снимка. Режим «вручную» оставлен для нестандартных значений и встраивания
// графа (config.graph). Список фильтруется по совместимости класса с текущей схемой.
function SubSchemaConfig({
  config,
  setConfig,
  subSchemaOptions,
}: {
  config: Record<string, unknown>;
  setConfig: (next: Record<string, unknown>) => void;
  subSchemaOptions: SubSchemaOption[];
}) {
  const slug = asString(config.schemaSlug);
  const selected = subSchemaOptions.find((option) => option.slug === slug) ?? null;
  const knownSlug = selected !== null;
  const [manual, setManual] = useState(() => slug !== '' && !knownSlug);
  // Группируем суб-схемы по классу для наглядных optgroup-ов.
  const grouped = SUB_SCHEMA_CLASSES.map((subClass) => ({
    subClass,
    options: subSchemaOptions.filter((option) => option.subSchemaClass === subClass),
  })).filter((group) => group.options.length > 0);
  // Выбор схемы (из списка либо вручную): кладём slug и снимок граничных портов ОДНИМ
  // патчем (issue #315). Раньше два setConfigKey подряд перетирали друг друга, и slug
  // терялся; теперь и ручной ввод известного slug подтягивает порты суб-схемы.
  const selectSlug = (nextSlug: string): void => {
    setConfig(subSchemaConfigPatch(config, nextSlug, subSchemaOptions));
  };
  return (
    <>
      <label className="checkbox-label">
        <input type="checkbox" checked={manual} onChange={(event) => setManual(event.target.checked)} />
        <span>Ввести slug вручную</span>
      </label>
      {manual ? (
        <label className="editor-label compact">
          Schema slug
          <input value={slug} onChange={(event) => selectSlug(event.target.value)} />
        </label>
      ) : (
        <label className="editor-label compact">
          Суб-схема
          <select value={slug} onChange={(event) => selectSlug(event.target.value)}>
            <option value="">— выберите суб-схему —</option>
            {grouped.map((group) => (
              <optgroup key={group.subClass} label={subSchemaClassLabel(group.subClass)}>
                {group.options.map((option) => (
                  <option key={option.slug} value={option.slug}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      )}
      {selected && (
        <p className="editor-hint">
          Порты: входы — {selected.ports.inputs.map((port) => port.id).join(', ') || '—'}; выходы —{' '}
          {selected.ports.outputs.map((port) => port.id).join(', ') || '—'}.
        </p>
      )}
      <JsonEditor label="Embedded graph" value={isRecord(config.graph) ? config.graph : {}} onChange={(value) => setConfig({ ...config, graph: value })} />
    </>
  );
}

// Диалог создания новой sub-схемы (issue #284): пользователь вводит slug и выбирает
// класс суб-схемы (issue #310). Slug проверяется на корректность и на то, что он не
// занят зарезервированными пайплайн-слагами (action/hint/illustration/support).
function NewSubSchemaModal({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (slug: string, subSchemaClass: SubSchemaClass) => void;
}) {
  const [slug, setSlug] = useState('');
  const [subSchemaClass, setSubSchemaClass] = useState<SubSchemaClass>('common');
  const [error, setError] = useState('');

  const SLUG_RE = /^[A-Za-z0-9_-]{1,100}$/;

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    const trimmed = slug.trim();
    if (!SLUG_RE.test(trimmed)) {
      setError('Slug должен содержать только латиницу, цифры, «-» или «_» и быть не длиннее 100 символов');
      return;
    }
    if (!isSubSchemaRouteSlug(trimmed)) {
      setError(`Slug «${trimmed}» зарезервирован за пайплайн-схемой — используйте другое имя`);
      return;
    }
    onConfirm(trimmed, subSchemaClass);
  }

  return (
    <Modal title="Создать суб-схему" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <label className="editor-label compact">
          Slug (имя схемы)
          <input
            value={slug}
            onChange={(event) => { setSlug(event.target.value); setError(''); }}
            placeholder="my-sub-schema"
            autoFocus
          />
        </label>
        <label className="editor-label compact">
          Класс суб-схемы
          <select value={subSchemaClass} onChange={(event) => setSubSchemaClass(event.target.value as SubSchemaClass)}>
            {SUB_SCHEMA_CLASSES.map((subClass) => (
              <option key={subClass} value={subClass}>{subSchemaClassLabel(subClass)}</option>
            ))}
          </select>
        </label>
        <p className="editor-hint">
          Класс задаёт, откуда суб-схему можно вызвать: «Общие» — отовсюду, «Игровые» — из
          игровых схем, «Поддержка» — из схемы поддержки.
        </p>
        <ErrorLine message={error} />
        <div className="button-row">
          <ToolbarButton icon={Plus} type="submit">Создать</ToolbarButton>
        </div>
      </form>
    </Modal>
  );
}

function LlmPortsEditor({
  label,
  mode,
  value,
  onChange,
  pathKey = 'jsonPath',
  pathLabel = 'JSON path',
  pathPlaceholder = 'value',
  showPath = true,
  addBaseName,
}: {
  label: string;
  mode: 'inputs' | 'outputs';
  value: unknown;
  onChange: (value: LlmPortRow[]) => void;
  pathKey?: 'jsonPath' | 'path';
  pathLabel?: string;
  pathPlaceholder?: string;
  showPath?: boolean;
  addBaseName?: string;
}) {
  const withPath = mode === 'outputs' && showPath;
  // Локальный стейт строк сохраняет порты с пустым именем во время редактирования,
  // чтобы пользователь мог стереть и набрать новое имя без удаления порта (issue #290).
  const [localRows, setLocalRows] = useState<LlmPortRow[]>(() => normalizeLlmPortRows(value));
  // Синхронизируем локальный стейт при внешнем изменении value (переключение узла и т.п.).
  const prevValueRef = useRef(value);
  if (prevValueRef.current !== value) {
    prevValueRef.current = value;
    const next = normalizeLlmPortRows(value);
    setLocalRows(next);
  }
  const draggedRowIndexRef = useRef<number | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  // commit вызывается только при структурных операциях (add/remove/reorder) и blur поля name.
  const commit = (next: LlmPortRow[]) => onChange(next.map(cleanLlmPortRow).filter((row) => row.name));
  // patchRowLocal обновляет только локальный стейт — без передачи в onChange.
  const patchRowLocal = (index: number, patch: Partial<LlmPortRow>) => {
    setLocalRows((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  };
  // При blur поля name фиксируем изменения в родителе (без пустых имён).
  const commitOnBlur = () => commit(localRows);
  const addRow = () => {
    const baseName = addBaseName ?? (mode === 'inputs' ? 'input' : 'value');
    const next = [...localRows, { name: nextPortName(localRows, baseName), type: 'any' as PortType, ...(withPath ? { [pathKey]: '' } : {}) }];
    setLocalRows(next);
    commit(next);
  };
  const removeRow = (index: number) => {
    const next = localRows.filter((_, rowIndex) => rowIndex !== index);
    setLocalRows(next);
    commit(next);
  };
  const moveRow = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= localRows.length || toIndex >= localRows.length) {
      return;
    }
    const next = reorderLlmPortRows(localRows, fromIndex, toIndex);
    setLocalRows(next);
    commit(next);
  };
  const handleDragStart = (event: ReactDragEvent, index: number) => {
    draggedRowIndexRef.current = index;
    setDraggedIndex(index);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
  };
  const handleDragOver = (event: ReactDragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };
  const handleDrop = (event: ReactDragEvent, index: number) => {
    event.preventDefault();
    const transferredText = event.dataTransfer.getData('text/plain');
    const transferredIndex = transferredText ? Number(transferredText) : -1;
    const fromIndex = draggedRowIndexRef.current ?? (Number.isInteger(transferredIndex) ? transferredIndex : -1);
    moveRow(fromIndex, index);
    draggedRowIndexRef.current = null;
    setDraggedIndex(null);
  };
  const handleDragEnd = () => {
    draggedRowIndexRef.current = null;
    setDraggedIndex(null);
  };

  return (
    <div className="schema-port-editor">
      <div className="subhead">{label}</div>
      <table className={mode === 'inputs' ? 'schema-port-table inputs' : 'schema-port-table outputs'}>
        <thead>
          <tr>
            <th className="schema-port-drag-cell" aria-label="Порядок" />
            <th>Name</th>
            {withPath && <th>{pathLabel}</th>}
            <th>Type</th>
            {mode === 'inputs' && <th>Description</th>}
            <th aria-label="Действия" />
          </tr>
        </thead>
        <tbody>
          {localRows.map((row, index) => (
            <tr
              className={draggedIndex === index ? 'schema-port-row-dragging' : undefined}
              key={`${label}-${index}`}
              onDragOver={handleDragOver}
              onDrop={(event) => handleDrop(event, index)}
            >
              <td className="schema-port-drag-cell">
                <button
                  className="schema-port-drag-button"
                  type="button"
                  draggable
                  onDragStart={(event) => handleDragStart(event, index)}
                  onDragEnd={handleDragEnd}
                  title="Переместить порт"
                  aria-label={`Переместить порт ${row.name || index + 1}`}
                >
                  <GripVertical size={14} />
                </button>
              </td>
              <td>
                <input
                  className="schema-port-name-input"
                  value={row.name}
                  onChange={(event) => patchRowLocal(index, { name: event.target.value })}
                  onBlur={commitOnBlur}
                  placeholder={mode === 'inputs' ? 'context' : 'value'}
                />
              </td>
              {withPath && (
                <td>
                  <input
                    value={row[pathKey] ?? ''}
                    onChange={(event) => patchRowLocal(index, { [pathKey]: event.target.value })}
                    onBlur={commitOnBlur}
                    placeholder={pathPlaceholder}
                  />
                </td>
              )}
              <td>
                <select
                  value={row.type}
                  onChange={(event) => {
                    const next = localRows.map((r, rowIndex) => rowIndex === index ? { ...r, type: asPortType(event.target.value) } : r);
                    setLocalRows(next);
                    commit(next);
                  }}
                >
                  {LLM_PORT_TYPES.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </td>
              {mode === 'inputs' && (
                <td>
                  <input
                    value={row.description ?? ''}
                    onChange={(event) => patchRowLocal(index, { description: event.target.value })}
                    onBlur={commitOnBlur}
                    placeholder="description"
                  />
                </td>
              )}
              <td>
                <button className="icon-button" type="button" onClick={() => removeRow(index)} title="Удалить порт">
                  <Trash2 size={16} />
                </button>
              </td>
            </tr>
          ))}
          {localRows.length === 0 && (
            <tr>
              <td colSpan={1 + 1 + (withPath ? 1 : 0) + 1 + (mode === 'inputs' ? 1 : 0) + 1}>Портов нет</td>
            </tr>
          )}
        </tbody>
      </table>
      <button className="button" type="button" onClick={addRow}>
        <Plus size={16} />
        <span>Добавить порт</span>
      </button>
    </div>
  );
}

function reorderLlmPortRows(rows: LlmPortRow[], fromIndex: number, toIndex: number): LlmPortRow[] {
  const next = [...rows];
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) return rows;
  next.splice(toIndex, 0, moved);
  return next;
}

// Строка конфига constant-узла (issue #319): { name, type, value }.
interface ConstantPortRow {
  name: string;
  type: string;
  value: string;
}

function asConstantPortType(value: unknown): string {
  return typeof value === 'string' && (CONSTANT_PORT_TYPES as readonly string[]).includes(value)
    ? value
    : 'string';
}

function normalizeConstantPortRows(value: unknown): ConstantPortRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row): ConstantPortRow | null => {
      if (!isRecord(row)) return null;
      const name = asString(row.name).trim();
      if (!name) return null;
      return { name, type: asConstantPortType(row.type), value: asString(row.value) };
    })
    .filter((row): row is ConstantPortRow => row !== null);
}

// JSON-типы константного порта, для которых значение задаётся JSON-текстом.
const CONSTANT_JSON_TYPES = new Set(['object', 'string_array', 'object_array']);

// Валидация JSON-значения константного порта по типу. Пустое значение допустимо
// (трактуется как «не задано»). Возвращает текст ошибки либо '' при успехе.
function constantJsonError(type: string, value: string): string {
  if (!CONSTANT_JSON_TYPES.has(type)) return '';
  const text = value.trim();
  if (!text) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'Некорректный JSON';
  }
  if (type === 'object') {
    if (!isRecord(parsed)) return 'Ожидается JSON-объект';
  } else if (type === 'string_array') {
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
      return 'Ожидается массив строк';
    }
  } else if (type === 'object_array') {
    if (!Array.isArray(parsed) || !parsed.every((item) => isRecord(item))) {
      return 'Ожидается массив объектов';
    }
  }
  return '';
}

// Редактор портов-констант (issue #319): строки { name, type, value }.
// Поддерживает типы string/number/boolean/object/string_array/object_array.
// Для string — кнопка раскрытия текстового редактора; для boolean — select;
// для object/string_array/object_array — textarea с валидацией JSON.
function ConstantPortsEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (value: ConstantPortRow[]) => void;
}) {
  const [localRows, setLocalRows] = useState<ConstantPortRow[]>(() => normalizeConstantPortRows(value));
  const prevValueRef = useRef(value);
  if (prevValueRef.current !== value) {
    prevValueRef.current = value;
    setLocalRows(normalizeConstantPortRows(value));
  }
  const draggedRowIndexRef = useRef<number | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  const commit = (next: ConstantPortRow[]) => onChange(next.filter((row) => row.name.trim()));
  const patchRowLocal = (index: number, patch: Partial<ConstantPortRow>) => {
    setLocalRows((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  };
  const commitOnBlur = () => commit(localRows);

  const addRow = () => {
    const used = new Set(localRows.map((r) => r.name));
    let name = 'value';
    for (let i = 2; used.has(name); i += 1) name = `value_${i}`;
    const next = [...localRows, { name, type: 'string', value: '' }];
    setLocalRows(next);
    commit(next);
  };

  const removeRow = (index: number) => {
    const next = localRows.filter((_, rowIndex) => rowIndex !== index);
    setLocalRows(next);
    commit(next);
  };

  const moveRow = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= localRows.length || toIndex >= localRows.length) return;
    const next = [...localRows];
    const [moved] = next.splice(fromIndex, 1);
    if (!moved) return;
    next.splice(toIndex, 0, moved);
    setLocalRows(next);
    commit(next);
  };

  const handleDragStart = (event: ReactDragEvent, index: number) => {
    draggedRowIndexRef.current = index;
    setDraggedIndex(index);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
  };
  const handleDragOver = (event: ReactDragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };
  const handleDrop = (event: ReactDragEvent, index: number) => {
    event.preventDefault();
    const transferredText = event.dataTransfer.getData('text/plain');
    const transferredIndex = transferredText ? Number(transferredText) : -1;
    const fromIndex = draggedRowIndexRef.current ?? (Number.isInteger(transferredIndex) ? transferredIndex : -1);
    moveRow(fromIndex, index);
    draggedRowIndexRef.current = null;
    setDraggedIndex(null);
  };
  const handleDragEnd = () => {
    draggedRowIndexRef.current = null;
    setDraggedIndex(null);
  };

  return (
    <div className="schema-port-editor">
      <p className="editor-hint">
        Узел без входов: каждый выход отдаёт заданное константное значение. Имя выхода = имени порта.
      </p>
      <div className="subhead">Outputs</div>
      {localRows.map((row, index) => (
        <div
          key={`constant-row-${index}`}
          className={`constant-port-row${draggedIndex === index ? ' schema-port-row-dragging' : ''}`}
          onDragOver={handleDragOver}
          onDrop={(event) => handleDrop(event, index)}
        >
          <button
            className="schema-port-drag-button"
            type="button"
            draggable
            onDragStart={(event) => handleDragStart(event, index)}
            onDragEnd={handleDragEnd}
            title="Переместить порт"
            aria-label={`Переместить порт ${row.name || index + 1}`}
          >
            <GripVertical size={14} />
          </button>
          <input
            className="schema-port-name-input"
            value={row.name}
            onChange={(event) => patchRowLocal(index, { name: event.target.value })}
            onBlur={commitOnBlur}
            placeholder="name"
          />
          <select
            className="constant-type-select"
            value={row.type}
            onChange={(event) => {
              const next = localRows.map((r, rowIndex) =>
                rowIndex === index ? { ...r, type: event.target.value, value: '' } : r,
              );
              setLocalRows(next);
              commit(next);
            }}
          >
            {(CONSTANT_PORT_TYPES as readonly string[]).map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
          <ConstantValueEditor
            type={row.type}
            value={row.value}
            onChange={(val) => {
              const next = localRows.map((r, rowIndex) => rowIndex === index ? { ...r, value: val } : r);
              setLocalRows(next);
              commit(next);
            }}
          />
          <button className="icon-button" type="button" onClick={() => removeRow(index)} title="Удалить порт">
            <Trash2 size={16} />
          </button>
        </div>
      ))}
      {localRows.length === 0 && <p className="editor-hint">Портов нет</p>}
      <button className="button" type="button" onClick={addRow}>
        <Plus size={16} />
        <span>Добавить порт</span>
      </button>
    </div>
  );
}

// Редактор значения одного константного порта (issue #319): вид зависит от типа.
// Все варианты обёрнуты в .constant-value-cell (flex:1), чтобы колонка значения имела
// одинаковую ширину во всех строках (доработка из issue #319: поля не должны смещаться).
// string — однострочный input + кнопка раскрытия текстового редактора.
// number — числовой input.
// boolean — select true/false.
// object/string_array/object_array — однострочный input + кнопка раскрытия JSON-редактора
// с валидацией (доработка из issue #319: JSON-поля как string).
function ConstantValueEditor({
  type,
  value,
  onChange,
}: {
  type: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (type === 'boolean') {
    return (
      <div className="constant-value-cell">
        <select
          className="constant-value-bool"
          value={value === 'true' ? 'true' : 'false'}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      </div>
    );
  }

  if (type === 'number') {
    return (
      <div className="constant-value-cell">
        <input
          type="number"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="0"
        />
      </div>
    );
  }

  // string и JSON-типы: однострочный ввод + кнопка раскрытия редактора в модальном окне.
  // JSON-типы валидируются (доработка из issue #319: поля JSON — как string, однострочные
  // с кнопкой раскрытия редактора).
  const isJson = CONSTANT_JSON_TYPES.has(type);
  const jsonError = isJson ? constantJsonError(type, value) : '';
  const placeholder = type === 'object' ? '{}' : isJson ? '[]' : 'значение';
  const modalTitle = isJson ? `Значение (${type}, JSON)` : 'Значение (string)';
  return (
    <div className="constant-value-cell">
      <input
        className={jsonError ? 'constant-value-input-error' : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
      />
      <button
        type="button"
        className="expandable-textarea-toggle"
        title="Раскрыть редактор"
        aria-label="Раскрыть редактор"
        onClick={() => setExpanded(true)}
      >
        <Maximize2 size={14} />
      </button>
      {jsonError && <span className="error-line constant-value-error">{jsonError}</span>}
      {expanded && (
        <div className="modal-overlay" onClick={() => setExpanded(false)} role="presentation">
          <div
            className="modal text-editor-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="modal-head">
              <span className="section-title">{modalTitle}</span>
              <button className="icon-button" type="button" onClick={() => setExpanded(false)} title="Закрыть">
                <X size={18} />
              </button>
            </div>
            <div className="modal-body text-editor-body">
              <div className="text-editor-json-area">
                <textarea
                  className="text-editor-textarea"
                  value={value}
                  rows={15}
                  placeholder={placeholder}
                  onChange={(event) => onChange(event.target.value)}
                  autoFocus
                  spellCheck={false}
                />
                <span className="error-line text-editor-json-error">{jsonError}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Редактор граничных портов суб-схемы (issue #310, #315): строки { id, label, type }.
// Форма приведена к стандарту остальных узлов (как у LlmPortsEditor): DnD-сортировка за
// ручку, без отдельной колонки «ID» — имя порта и есть его идентификатор, а человекочитаемое
// имя редактируется в колонке «Description» (хранится как label). id валидируется по
// BOUNDARY_PORT_ID_RE (латиница/цифры/underscore, 1..40): невалидный или пустой id
// подсвечивается и не фиксируется в граф. Хранится в config.outputs узла start (входы
// суб-схемы) либо config.inputs узла end (её выходы).
function BoundaryPortsEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (value: BoundaryPortRow[]) => void;
}) {
  const [localRows, setLocalRows] = useState<BoundaryPortRow[]>(() => normalizeBoundaryPortRows(value));
  const prevValueRef = useRef(value);
  if (prevValueRef.current !== value) {
    prevValueRef.current = value;
    setLocalRows(normalizeBoundaryPortRows(value));
  }
  const draggedRowIndexRef = useRef<number | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  // В граф фиксируем только строки с валидным id (без дублей), чтобы не нарушать контракт.
  const commit = (next: BoundaryPortRow[]) => {
    const seen = new Set<string>();
    const clean = next
      .map((row) => ({ id: row.id.trim(), label: row.label.trim(), type: row.type }))
      .filter((row) => {
        if (!BOUNDARY_PORT_ID_RE.test(row.id) || seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      });
    onChange(clean);
  };
  const patchRowLocal = (index: number, patch: Partial<BoundaryPortRow>) => {
    setLocalRows((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  };
  const commitOnBlur = () => commit(localRows);
  const addRow = () => {
    const used = new Set(localRows.map((row) => row.id));
    let id = 'port';
    for (let index = 2; used.has(id); index += 1) id = `port_${index}`;
    const next = [...localRows, { id, label: '', type: 'any' as BoundaryPortType }];
    setLocalRows(next);
    commit(next);
  };
  const removeRow = (index: number) => {
    const next = localRows.filter((_, rowIndex) => rowIndex !== index);
    setLocalRows(next);
    commit(next);
  };
  const moveRow = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= localRows.length || toIndex >= localRows.length) {
      return;
    }
    const next = [...localRows];
    const [moved] = next.splice(fromIndex, 1);
    if (!moved) return;
    next.splice(toIndex, 0, moved);
    setLocalRows(next);
    commit(next);
  };
  const handleDragStart = (event: ReactDragEvent, index: number) => {
    draggedRowIndexRef.current = index;
    setDraggedIndex(index);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
  };
  const handleDragOver = (event: ReactDragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };
  const handleDrop = (event: ReactDragEvent, index: number) => {
    event.preventDefault();
    const transferredText = event.dataTransfer.getData('text/plain');
    const transferredIndex = transferredText ? Number(transferredText) : -1;
    const fromIndex = draggedRowIndexRef.current ?? (Number.isInteger(transferredIndex) ? transferredIndex : -1);
    moveRow(fromIndex, index);
    draggedRowIndexRef.current = null;
    setDraggedIndex(null);
  };
  const handleDragEnd = () => {
    draggedRowIndexRef.current = null;
    setDraggedIndex(null);
  };
  return (
    <div className="schema-port-editor">
      <div className="subhead">{label}</div>
      <table className="schema-port-table inputs">
        <thead>
          <tr>
            <th className="schema-port-drag-cell" aria-label="Порядок" />
            <th>Name</th>
            <th>Type</th>
            <th>Description</th>
            <th aria-label="Действия" />
          </tr>
        </thead>
        <tbody>
          {localRows.map((row, index) => (
            <tr
              className={draggedIndex === index ? 'schema-port-row-dragging' : undefined}
              key={`${label}-${index}`}
              onDragOver={handleDragOver}
              onDrop={(event) => handleDrop(event, index)}
            >
              <td className="schema-port-drag-cell">
                <button
                  className="schema-port-drag-button"
                  type="button"
                  draggable
                  onDragStart={(event) => handleDragStart(event, index)}
                  onDragEnd={handleDragEnd}
                  title="Переместить порт"
                  aria-label={`Переместить порт ${row.id || index + 1}`}
                >
                  <GripVertical size={14} />
                </button>
              </td>
              <td>
                <input
                  className={`schema-port-name-input${BOUNDARY_PORT_ID_RE.test(row.id.trim()) ? '' : ' is-invalid'}`}
                  value={row.id}
                  onChange={(event) => patchRowLocal(index, { id: event.target.value })}
                  onBlur={commitOnBlur}
                  placeholder="context"
                />
              </td>
              <td>
                <select
                  value={row.type}
                  onChange={(event) => {
                    const next = localRows.map((r, rowIndex) =>
                      rowIndex === index ? { ...r, type: asPortType(event.target.value) as BoundaryPortType } : r,
                    );
                    setLocalRows(next);
                    commit(next);
                  }}
                >
                  {LLM_PORT_TYPES.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  value={row.label}
                  onChange={(event) => patchRowLocal(index, { label: event.target.value })}
                  onBlur={commitOnBlur}
                  placeholder="description"
                />
              </td>
              <td>
                <button className="icon-button" type="button" onClick={() => removeRow(index)} title="Удалить порт">
                  <Trash2 size={16} />
                </button>
              </td>
            </tr>
          ))}
          {localRows.length === 0 && (
            <tr>
              <td colSpan={5}>Портов нет</td>
            </tr>
          )}
        </tbody>
      </table>
      <button className="button" type="button" onClick={addRow}>
        <Plus size={16} />
        <span>Добавить порт</span>
      </button>
    </div>
  );
}

function normalizeBoundaryPortRows(value: unknown): BoundaryPortRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row): BoundaryPortRow | null => {
      if (!isRecord(row)) return null;
      const id = asString(row.id).trim();
      if (!id) return null;
      const type = asPortType(row.type);
      return {
        id,
        label: asString(row.label),
        type: (isBoundaryPortType(type) ? type : 'any') as BoundaryPortType,
      };
    })
    .filter((row): row is BoundaryPortRow => row !== null);
}

function JsonEditor({
  label,
  value,
  onChange,
  rows = 5,
}: {
  label: string;
  value: unknown;
  onChange: (value: Record<string, unknown> | unknown[]) => void;
  rows?: number;
}) {
  const [text, setText] = useState(jsonPreview(value));
  const [error, setError] = useState('');

  useEffect(() => {
    setText(jsonPreview(value));
    setError('');
  }, [value]);

  function commit(): void {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!isRecord(parsed) && !Array.isArray(parsed)) throw new Error('JSON должен быть объектом или массивом');
      onChange(parsed);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Некорректный JSON');
    }
  }

  return (
    <label className="editor-label compact">
      {label}
      <textarea value={text} onChange={(event) => setText(event.target.value)} onBlur={commit} rows={rows} spellCheck={false} />
      <span className="error-line json-editor-error">{error}</span>
    </label>
  );
}

// Сведения об изолированном тесте тела узла (issue #390): путь к узлу в дереве
// тел и сам тестируемый узел с его родительским графом для разрешения портов.
interface BodyTestInfo {
  nodePath: string[];
  node: NodeDefinition;
  parentGraph: SchemaGraph;
}

function SchemaTestModal({
  token,
  slug,
  schemaType,
  graph,
  bodyTest,
  defaultGameId,
  games,
  onClose,
  onFailedNode,
  onSelectNode,
}: {
  token: string;
  slug: string;
  schemaType: SchemaPaletteKind;
  graph: SchemaGraph;
  bodyTest: BodyTestInfo | null;
  defaultGameId: string | null;
  games: ApiRecord[];
  onClose: () => void;
  onFailedNode: (nodeId: string | null) => void;
  onSelectNode: (nodeId: string | null) => void;
}) {
  // Суб-схема (issue #343): поля ввода строятся по составу start-узла (граничные
  // входы суб-схемы), а не по фиксированному типу пайплайн-схемы.
  const isSub = isSubSchemaClass(schemaType) || isSubSchemaGraph(graph);
  // Класс тестируемой суб-схемы (issue #351): из палитры или из самого графа.
  const subClass: SubSchemaClass | null = isSub
    ? isSubSchemaClass(schemaType)
      ? schemaType
      : isSubSchemaGraph(graph)
        ? graph.subSchemaClass ?? 'common'
        : 'common'
    : null;
  // Контекст выполнения суб-схемы (issue #351): домен вызывающей стороны.
  // - support-суб-схема исполняется только в поддержке;
  // - game-суб-схема — только в игре (нужно выбрать игру);
  // - common-суб-схема универсальна: оператор выбирает «поддержка» или «игра».
  const [contextClass, setContextClass] = useState<'support' | 'game'>(() =>
    subClass === 'game' ? 'game' : 'support',
  );
  // Выбранная игра контекста (issue #351): нужна, когда контекст — «игра».
  const [contextGameId, setContextGameId] = useState<string>(defaultGameId ?? '');
  // Контекст показываем только для суб-схем; для common он выбирается, для
  // game/support — зафиксирован классом и игру выбирают только для game.
  const showContext = isSub;
  const showGamePicker = showContext && contextClass === 'game';
  // Изолированный тест тела узла (issue #390): когда модалка открыта внутри тела
  // узла, поля ввода строятся по входным data-портам самого тестируемого узла, а
  // запрос дополняется nodePath, по которому сервер прогоняет только это тело.
  const isBody = bodyTest !== null;
  const fields = useMemo(
    () =>
      bodyTest
        ? nodeBodyTestInputFields(bodyTest.node, bodyTest.parentGraph)
        : isSub
          ? subSchemaTestInputFields(graph)
          : testInputFields(schemaType),
    [bodyTest, isSub, graph, schemaType],
  );
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(() =>
    bodyTest
      ? initialNodeBodyFieldValues(bodyTest.node, bodyTest.parentGraph)
      : isSub
        ? initialSubSchemaFieldValues(graph)
        : initialFieldValues(schemaType),
  );
  const [advanced, setAdvanced] = useState(false);
  const [inputs, setInputs] = useState(() =>
    bodyTest
      ? jsonPreview(defaultNodeBodyTestInputValues(bodyTest.node, bodyTest.parentGraph))
      : isSub
        ? jsonPreview(defaultSubSchemaTestInputValues(graph))
        : defaultTestInputs(schemaType),
  );
  const [result, setResult] = useState<SchemaTestResult | null>(null);
  const [lastRunInputs, setLastRunInputs] = useState<Record<string, unknown> | null>(null);
  const [lastRunContext, setLastRunContext] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportCopyStatus, setExportCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [error, setError] = useState('');
  // Узел, в котором произошла ошибка теста (issue #266): показываем рядом с текстом
  // ошибки, чтобы оператор сразу видел источник сбоя, а не только его описание.
  const [errorNode, setErrorNode] = useState<{ id: string; type: string | null } | null>(null);
  // Отчёт по узлам из ответа об ошибке (issue #347): движок наполняет nodeTrace по
  // ходу исполнения, поэтому при сбое теста видно, какие ноды успели отработать и на
  // какой именно остановился поток.
  const [errorTrace, setErrorTrace] = useState<SchemaTestNodeTraceEntry[]>([]);
  const [busy, setBusy] = useState(false);

  async function runTest(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    setErrorNode(null);
    setErrorTrace([]);
    setResult(null);
    setLastRunInputs(null);
    setLastRunContext(null);
    setExportOpen(false);
    setExportCopyStatus('idle');
    onFailedNode(null);
    try {
      const parsedInputs = advanced
        ? (JSON.parse(inputs) as Record<string, unknown>)
        : bodyTest
          ? buildNodeBodyTestInputs(bodyTest.node, bodyTest.parentGraph, fieldValues)
          : isSub
            ? buildSubSchemaTestInputs(graph, fieldValues)
            : buildTestInputs(schemaType, fieldValues);
      // Контекст выполнения суб-схемы (issue #351): для суб-схемы передаём домен
      // вызывающей стороны (support/game) и — при контексте «игра» — выбранную игру.
      // Для пайплайн-схем контекст не отправляется, а gameId берётся из активной
      // области редактора, как и раньше.
      const requestGameId = isSub
        ? contextClass === 'game'
          ? contextGameId || undefined
          : undefined
        : defaultGameId ?? undefined;
      const runContext = isSub
        ? contextClass === 'game'
          ? requestGameId
            ? `Игра (${requestGameId})`
            : 'Игра (тестовый манифест)'
          : 'Поддержка'
        : requestGameId
          ? `Игра (${requestGameId})`
          : 'Без игры';
      // Сохраняем входные параметры и контекст ДО запроса (issue #400): тогда они
      // попадут в Markdown-отчёт не только при успехе, но и при ошибке теста.
      setLastRunInputs(parsedInputs);
      setLastRunContext(runContext);
      const data = await schemaRequest<SchemaTestResult>(token, `/api/schemas/${slug}/test`, {
        method: 'POST',
        body: JSON.stringify({
          inputs: parsedInputs,
          gameId: requestGameId,
          ...(isSub ? { context: contextClass } : {}),
          ...(bodyTest ? { nodePath: bodyTest.nodePath } : {}),
        }),
      });
      setResult(data);
    } catch (err) {
      const failedNode = err instanceof SchemaRequestError ? extractFailedNodeId(err.data) : null;
      const failedNodeType = err instanceof SchemaRequestError ? extractFailedNodeType(err.data) : null;
      onFailedNode(failedNode);
      setErrorNode(failedNode ? { id: failedNode, type: failedNodeType } : null);
      setErrorTrace(err instanceof SchemaRequestError ? extractErrorNodeTrace(err.data) : []);
      setError(err instanceof Error ? err.message : 'Не удалось выполнить тест');
    } finally {
      setBusy(false);
    }
  }

  const schemaKindLabel = isSub
    ? subSchemaClassLabel(subClass ?? 'common')
    : paletteKindLabel(schemaType);
  const exportMarkdown = result
    ? buildSchemaTestMarkdown({
        slug,
        title: isSub ? 'Суб-схема' : 'Схема',
        schemaKind: schemaKindLabel,
        context: lastRunContext ?? '—',
        inputs: lastRunInputs ?? {},
        result,
      })
    : // Отчёт об ошибке теста (issue #400): когда запуск падает, результата нет,
      // но оператору всё равно нужен Markdown с входными данными, текстом ошибки и
      // логом узлов, чтобы приложить его к задаче на доработку.
      error
      ? buildSchemaTestErrorMarkdown({
          slug,
          title: isSub ? 'Суб-схема' : 'Схема',
          schemaKind: schemaKindLabel,
          context: lastRunContext ?? '—',
          inputs: lastRunInputs ?? {},
          error,
          errorNode,
          errorTrace,
        })
      : '';

  async function copyExportMarkdown(): Promise<void> {
    const ok = await copyTextToClipboard(exportMarkdown);
    setExportCopyStatus(ok ? 'copied' : 'failed');
  }

  return (
    <>
      <Modal
        title={
          bodyTest
            ? `Тест тела узла ${bodyTest.node.label || bodyTest.node.id} (${bodyTest.nodePath.join(' / ')})`
            : `Тест схемы ${slug}`
        }
        onClose={onClose}
      >
        <form className="schema-test-form" onSubmit={runTest}>
          {showContext && (
            <div className="schema-test-context">
              <label className="editor-label compact">
                Контекст выполнения
                {subClass === 'common' ? (
                  <select
                    value={contextClass}
                    onChange={(event) => setContextClass(event.target.value as 'support' | 'game')}
                  >
                    <option value="support">🛟 Поддержка</option>
                    <option value="game">🎮 Игра</option>
                  </select>
                ) : (
                  <input value={contextClass === 'game' ? '🎮 Игра' : '🛟 Поддержка'} readOnly disabled />
                )}
              </label>
              {showGamePicker && (
                <label className="editor-label compact">
                  Игра
                  <select value={contextGameId} onChange={(event) => setContextGameId(event.target.value)}>
                    <option value="">— без игры (тестовый манифест) —</option>
                    {games.map((game) => {
                      const id = field(game, 'game_id');
                      return (
                        <option key={id} value={id}>
                          🎮 {field(game, 'name') || id}
                        </option>
                      );
                    })}
                  </select>
                </label>
              )}
            </div>
          )}
          {advanced ? (
            <label className="editor-label compact">
              <span className="editor-label-head">
                Inputs JSON
                <HelpHint topic={SCHEMA_TEST_HELP.inputs} />
              </span>
              <textarea value={inputs} onChange={(event) => setInputs(event.target.value)} rows={10} spellCheck={false} />
            </label>
          ) : fields.length > 0 ? (
            fields.map((inputField) => (
              <label className="editor-label compact" key={inputField.key}>
                {helpTopicForField(inputField.key) ? (
                  <span className="editor-label-head">
                    {inputField.label}
                    <HelpHint topic={helpTopicForField(inputField.key) as SchemaHelpTopic} />
                  </span>
                ) : (
                  inputField.label
                )}
                {inputField.kind === 'textarea' || inputField.kind === 'json' ? (
                  <textarea
                    value={fieldValues[inputField.key] ?? ''}
                    placeholder={inputField.placeholder}
                    onChange={(event) =>
                      setFieldValues((current) => ({ ...current, [inputField.key]: event.target.value }))
                    }
                    rows={inputField.kind === 'json' ? 6 : 4}
                    spellCheck={false}
                  />
                ) : (
                  <input
                    value={fieldValues[inputField.key] ?? ''}
                    placeholder={inputField.placeholder}
                    onChange={(event) =>
                      setFieldValues((current) => ({ ...current, [inputField.key]: event.target.value }))
                    }
                  />
                )}
              </label>
            ))
          ) : isBody ? (
            <p className="editor-hint">
              У тестируемого узла нет входных портов данных — тело прогоняется без начальных
              значений, либо задайте их в расширенном режиме.
            </p>
          ) : isSub ? (
            <p className="editor-hint">
              У start-узла суб-схемы нет входов — добавьте граничные порты в start-узел, чтобы
              задавать начальные значения, либо используйте расширенный режим.
            </p>
          ) : (
            <p className="editor-hint">
              Для этого типа схемы специальных полей ввода нет — тест использует значения по умолчанию.
            </p>
          )}
          <label className="checkbox-label">
            <input type="checkbox" checked={advanced} onChange={(event) => setAdvanced(event.target.checked)} />
            <span>Расширенный режим: задать Inputs JSON вручную</span>
          </label>
          <ToolbarButton icon={Play} type="submit" disabled={busy}>{busy ? 'Запуск…' : 'Запустить'}</ToolbarButton>
        </form>
        <ErrorLine message={error} />
        {error && errorNode && (
          <div className="error-line schema-test-error-node">
            Узел с ошибкой:{' '}
            <button
              type="button"
              className="schema-test-error-node-link"
              onClick={() => onSelectNode(errorNode.id)}
              title="Выделить узел на схеме"
            >
              {errorNode.id}
              {errorNode.type ? ` · ${nodeTypeLabel(errorNode.type)}` : ''}
            </button>
          </div>
        )}
        {error && (
          <div className="schema-test-result-actions">
            <ToolbarButton icon={Download} onClick={() => {
              setExportCopyStatus('idle');
              setExportOpen(true);
            }}>
              Экспорт MD
            </ToolbarButton>
          </div>
        )}
        {error && errorTrace.length > 0 && (
          <NodeTraceReport trace={errorTrace} onSelectNode={onSelectNode} />
        )}
        {result && (
          <>
            <div className="schema-test-result-actions">
              <ToolbarButton icon={Download} onClick={() => {
                setExportCopyStatus('idle');
                setExportOpen(true);
              }}>
                Экспорт MD
              </ToolbarButton>
            </div>
            <dl className="meta-list">
              <dt>Duration</dt>
              <dd>{result.durationMs} ms</dd>
              <dt>Cost</dt>
              <dd>{moneyMillicents(result.costMillicents)}</dd>
            </dl>
            <div className="subhead">Outputs</div>
            <pre className="json-box">{jsonPreview(result.outputs)}</pre>
            {result.nodeTrace && result.nodeTrace.length > 0 && (
              <NodeTraceReport trace={result.nodeTrace} onSelectNode={onSelectNode} />
            )}
            <div className="subhead">LLM log · {result.llmLog.length}</div>
            {result.llmLog.length === 0 && <pre className="json-box">—</pre>}
            <div className="llm-log-records">
              {result.llmLog.map((entry, index) => {
                const source = [entry.schemaSlug || '—', entry.nodeId || '—'].join(' · ');
                return (
                  <details key={`${entry.nodeId ?? 'rec'}-${index}`} className="llm-log-record">
                    <summary>
                      <span className="llm-log-source">{index + 1}. {source}</span>
                      <span className={entry.errorText ? 'badge badge-error' : 'badge'}>
                        {entry.errorText ? 'ошибка' : 'ок'}
                      </span>
                    </summary>
                    {entry.nodeId && (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => onSelectNode(entry.nodeId as string)}
                      >
                        Перейти к узлу «{entry.nodeId}»
                      </button>
                    )}
                    {entry.requestText && (
                      <>
                        <div className="subhead">Запрос</div>
                        <pre className="json-box">{entry.requestText}</pre>
                      </>
                    )}
                    {entry.errorText ? (
                      <>
                        <div className="subhead">Ошибка</div>
                        <pre className="json-box error-box">{entry.errorText}</pre>
                      </>
                    ) : (
                      entry.responseText && (
                        <>
                          <div className="subhead">Ответ</div>
                          <pre className="json-box">{entry.responseText}</pre>
                        </>
                      )
                    )}
                  </details>
                );
              })}
            </div>
          </>
        )}
      </Modal>
      {exportOpen && exportMarkdown && (
        <SchemaTestExportModal
          markdown={exportMarkdown}
          copyStatus={exportCopyStatus}
          onCopy={() => void copyExportMarkdown()}
          onClose={() => setExportOpen(false)}
        />
      )}
    </>
  );
}

function SchemaTestExportModal({
  markdown,
  copyStatus,
  onCopy,
  onClose,
}: {
  markdown: string;
  copyStatus: 'idle' | 'copied' | 'failed';
  onCopy: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title="Экспорт результата теста" onClose={onClose}>
      <div className="schema-test-export-actions">
        <ToolbarButton icon={Copy} onClick={onCopy}>Копировать</ToolbarButton>
        {copyStatus === 'copied' && <span className="editor-hint">Скопировано</span>}
        {copyStatus === 'failed' && <span className="error-line">Не удалось скопировать</span>}
      </div>
      <textarea
        className="schema-test-export-text"
        value={markdown}
        readOnly
        spellCheck={false}
        aria-label="Markdown отчёта"
      />
    </Modal>
  );
}

interface SchemaTestMarkdownInput {
  slug: string;
  title: string;
  schemaKind: string;
  context: string;
  inputs: Record<string, unknown>;
  result: SchemaTestResult;
}

function buildSchemaTestMarkdown({ slug, title, schemaKind, context, inputs, result }: SchemaTestMarkdownInput): string {
  const lines = [
    `# Результат теста: ${slug}`,
    '',
    '## Объект',
    '',
    `- ${title}: ${slug}`,
    `- Тип: ${schemaKind}`,
    '',
    '## Контекст выполнения',
    '',
    context,
    '',
    '## Начальные параметры запуска теста',
    '',
    fencedJson(inputs),
    '',
    '## Duration',
    '',
    `${result.durationMs} ms`,
    '',
    '## Cost',
    '',
    moneyMillicents(result.costMillicents),
    '',
    '## Outputs',
    '',
    fencedJson(result.outputs),
    '',
    `## Лог узлов (${result.nodeTrace?.length ?? 0})`,
    '',
    formatNodeTraceMarkdown(result.nodeTrace ?? []),
    '',
    `## Данные по узлам (${result.nodeTrace?.length ?? 0})`,
    '',
    formatNodeDataMarkdown(result.nodeTrace ?? []),
    '',
    `## LLM log (${result.llmLog.length})`,
    '',
    formatLlmLogMarkdown(result.llmLog),
  ];
  return lines.join('\n').trimEnd();
}

interface SchemaTestErrorMarkdownInput {
  slug: string;
  title: string;
  schemaKind: string;
  context: string;
  inputs: Record<string, unknown>;
  error: string;
  errorNode: { id: string; type: string | null } | null;
  errorTrace: SchemaTestNodeTraceEntry[];
}

// Markdown-отчёт об упавшем тесте (issue #400): зеркалит структуру успешного
// отчёта, но вместо Outputs/Cost кладёт текст ошибки, упавший узел и лог тех узлов,
// что успели отработать до сбоя. Готов к вставке в задачу на доработку.
function buildSchemaTestErrorMarkdown({
  slug,
  title,
  schemaKind,
  context,
  inputs,
  error,
  errorNode,
  errorTrace,
}: SchemaTestErrorMarkdownInput): string {
  const lines = [
    `# Ошибка теста: ${slug}`,
    '',
    '## Объект',
    '',
    `- ${title}: ${slug}`,
    `- Тип: ${schemaKind}`,
    '',
    '## Контекст выполнения',
    '',
    context,
    '',
    '## Начальные параметры запуска теста',
    '',
    fencedJson(inputs),
    '',
    '## Ошибка',
    '',
    fencedText(error),
    '',
    '## Узел с ошибкой',
    '',
    errorNode
      ? `${errorNode.id}${errorNode.type ? ` · ${nodeTypeLabel(errorNode.type)}` : ''}`
      : 'Не определён.',
    '',
    `## Лог узлов (${errorTrace.length})`,
    '',
    formatNodeTraceMarkdown(errorTrace),
    '',
    `## Данные по узлам (${errorTrace.length})`,
    '',
    formatNodeDataMarkdown(errorTrace),
  ];
  return lines.join('\n').trimEnd();
}

function fencedJson(value: unknown): string {
  return ['```json', jsonPreview(value), '```'].join('\n');
}

function formatNodeTraceMarkdown(trace: SchemaTestNodeTraceEntry[]): string {
  if (trace.length === 0) return 'Нет данных.';
  const rows = trace.map((entry) =>
    [
      String(entry.order),
      markdownCell(entry.nodeId),
      markdownCell(nodeTypeLabel(entry.nodeType)),
      entry.via === 'data' ? 'данные' : 'поток',
      `${entry.durationMs} ms`,
      markdownCell(entry.outputKeys.length > 0 ? entry.outputKeys.join(', ') : '—'),
      entry.failed ? 'ошибка' : 'ок',
    ].join(' | '),
  );
  return [
    '| # | Узел | Тип | Как | Время | Выходы | Статус |',
    '| - | - | - | - | - | - | - |',
    ...rows.map((row) => `| ${row} |`),
  ].join('\n');
}

function formatNodeDataMarkdown(trace: SchemaTestNodeTraceEntry[]): string {
  if (trace.length === 0) return 'Нет данных.';
  return trace
    .map((entry) => {
      const inputs = entry.inputs ?? {};
      // В экспорт входы кладём для упавшего узла всегда (issue #406) и для
      // остальных, если они непустые.
      const showInputs = entry.failed || Object.keys(inputs).length > 0;
      return [
        `### ${entry.order}. ${entry.nodeId} · ${nodeTypeLabel(entry.nodeType)}`,
        '',
        `- Схема: ${entry.schemaSlug}`,
        `- Способ: ${entry.via === 'data' ? 'данные' : 'поток'}`,
        `- Duration: ${entry.durationMs} ms`,
        `- Статус: ${entry.failed ? 'ошибка' : 'ок'}`,
        '',
        ...(showInputs ? [`#### Входы${entry.failed ? ' (узел упал)' : ''}`, '', fencedJson(inputs), ''] : []),
        '#### Выходы',
        '',
        fencedJson(entry.outputs),
      ].join('\n');
    })
    .join('\n\n');
}

function formatLlmLogMarkdown(log: SchemaTestLogEntry[]): string {
  if (log.length === 0) return 'Нет данных.';
  return log
    .map((entry, index) => {
      const blocks: string[] = [];
      if (entry.requestText) blocks.push(['#### Request', '', fencedText(entry.requestText)].join('\n'));
      if (entry.responseText) blocks.push(['#### Response', '', fencedText(entry.responseText)].join('\n'));
      if (entry.errorText) blocks.push(['#### Error', '', fencedText(entry.errorText)].join('\n'));
      return [
        `### ${entry.nodeId ?? `Запись ${index + 1}`}`,
        '',
        `- Схема: ${entry.schemaSlug ?? '—'}`,
        `- Статус: ${entry.errorText ? 'ошибка' : 'ок'}`,
        '',
        blocks.length > 0 ? blocks.join('\n\n') : '—',
      ].join('\n');
    })
    .join('\n\n');
}

function fencedText(value: string): string {
  return ['```', value, '```'].join('\n');
}

function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Падаем в запасной вариант ниже.
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

// Полный лог исполнения схемы по узлам (issue #347): отчёт по КАЖДОЙ ноде, через
// которую прошёл поток, и по каждой pure-ноде, к которой был запрос данных. Строка
// кликабельна — выделяет узел на canvas; ниже разворачиваются выходы каждой ноды.
function NodeTraceReport({
  trace,
  onSelectNode,
}: {
  trace: SchemaTestNodeTraceEntry[];
  onSelectNode: (nodeId: string | null) => void;
}) {
  return (
    <div className="schema-test-node-trace">
      <div className="subhead">Лог узлов · {trace.length}</div>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Узел</th>
            <th>Тип</th>
            <th>Как</th>
            <th>Время</th>
            <th>Выходы</th>
            <th>Статус</th>
          </tr>
        </thead>
        <tbody>
          {trace.map((entry) => (
            <tr
              key={`trace-${entry.order}`}
              className={entry.failed ? 'schema-test-node-trace-row--failed' : undefined}
              onClick={() => onSelectNode(entry.nodeId)}
              title="Выделить узел на схеме"
            >
              <td>{entry.order}</td>
              <td>
                {entry.depth > 0 ? '↳ '.repeat(entry.depth) : ''}
                {entry.nodeId}
                {entry.depth > 0 ? ` · ${entry.schemaSlug}` : ''}
              </td>
              <td>{nodeTypeLabel(entry.nodeType)}</td>
              <td>
                <span className={entry.via === 'data' ? 'badge badge-data' : 'badge'}>
                  {entry.via === 'data' ? 'данные' : 'поток'}
                </span>
              </td>
              <td>{entry.durationMs} ms</td>
              <td>{entry.outputKeys.length > 0 ? entry.outputKeys.join(', ') : '—'}</td>
              <td>
                <span className={entry.failed ? 'badge badge-error' : 'badge'}>
                  {entry.failed ? 'ошибка' : 'ок'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {trace.map((entry) => {
        const inputs = entry.inputs ?? {};
        // Входы показываем для упавшего узла всегда (issue #406) и для остальных,
        // если по data-портам действительно что-то пришло, — иначе не шумим.
        const showInputs = entry.failed || Object.keys(inputs).length > 0;
        return (
          <div key={`trace-detail-${entry.order}`}>
            <div className="subhead">
              {entry.order}. {entry.nodeId} · {nodeTypeLabel(entry.nodeType)}
              {entry.via === 'data' ? ' · данные' : ''}
            </div>
            {showInputs && (
              <>
                <div className="schema-test-node-trace-label">
                  Входы{entry.failed ? ' (узел упал)' : ''}
                </div>
                <pre className={entry.failed ? 'json-box error-box' : 'json-box'}>
                  {jsonPreview(inputs)}
                </pre>
                <div className="schema-test-node-trace-label">Выходы</div>
              </>
            )}
            <pre className={entry.failed ? 'json-box error-box' : 'json-box'}>
              {jsonPreview(entry.outputs)}
            </pre>
          </div>
        );
      })}
    </div>
  );
}

function extractImportPreview(
  payload: unknown,
  slug: string,
  current: SchemaGraph,
  currentDescription: string,
): ImportPreview {
  const record = extractSchemaRecord(payload, slug);
  const graph = normalizeSchemaGraph(record.graphJson);
  if (graph.slug !== slug) throw new Error(`Импортируемая схема должна иметь slug ${slug}`);
  const description = record.description ?? currentDescription;
  return {
    graph,
    description,
    summary: [
      `Ноды: ${current.nodes.length} -> ${graph.nodes.length}`,
      `рёбра: ${current.edges.length} -> ${graph.edges.length}`,
      `описание: ${description === currentDescription ? 'без изменений' : 'обновится'}`,
    ].join('; '),
  };
}

function extractSchemaRecord(payload: unknown, slug: string): { graphJson: unknown; description?: string } {
  if (isRecord(payload) && payload.version === 1 && Array.isArray(payload.nodes)) {
    return { graphJson: payload };
  }
  if (isRecord(payload) && (payload.graphJson || payload.graph_json)) {
    return {
      graphJson: payload.graphJson ?? payload.graph_json,
      description: typeof payload.description === 'string' ? payload.description : undefined,
    };
  }
  if (isRecord(payload) && Array.isArray(payload.items)) {
    const items = payload.items.filter(isRecord);
    const item =
      items.find((candidate) => (candidate.schemaSlug ?? candidate.schema_slug) === slug) ??
      items[0];
    if (!item) throw new Error('Файл импорта не содержит schemas.items');
    return {
      graphJson: item.graphJson ?? item.graph_json,
      description: typeof item.description === 'string' ? item.description : undefined,
    };
  }
  throw new Error('Файл импорта должен содержать graph JSON или export schemas.items');
}

async function schemaRequest<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    throw new SchemaRequestError(errorMessageFromResponse(data, response.status), response.status, data);
  }
  return data as T;
}

function errorMessageFromResponse(data: unknown, status: number): string {
  if (isRecord(data) && typeof data.message === 'string') return data.message;
  if (isRecord(data) && isRecord(data.message) && typeof data.message.message === 'string') {
    return data.message.message;
  }
  return `HTTP ${status}`;
}

function extractFailedNodeId(data: unknown): string | null {
  const message = isRecord(data) ? data.message : null;
  if (isRecord(message) && typeof message.nodeId === 'string') return message.nodeId;
  return null;
}

// Тип упавшего узла из ответа об ошибке test-run (issue #266): нужен, чтобы в окне теста
// рядом со строкой ошибки показать, в каком узле она произошла.
function extractFailedNodeType(data: unknown): string | null {
  const message = isRecord(data) ? data.message : null;
  if (isRecord(message) && typeof message.nodeType === 'string') return message.nodeType;
  return null;
}

// Отчёт по узлам из ответа об ошибке test-run (issue #347): сервер кладёт nodeTrace
// в тело BadRequest. Поле может лежать как на верхнем уровне, так и под message —
// зависит от того, как NestJS сериализует исключение, поэтому проверяем оба места.
function extractErrorNodeTrace(data: unknown): SchemaTestNodeTraceEntry[] {
  if (isRecord(data) && Array.isArray(data.nodeTrace)) {
    return data.nodeTrace as SchemaTestNodeTraceEntry[];
  }
  if (isRecord(data) && isRecord(data.message) && Array.isArray(data.message.nodeTrace)) {
    return data.message.nodeTrace as SchemaTestNodeTraceEntry[];
  }
  return [];
}

// Человекочитаемая подпись типа узла; неизвестный тип показываем как есть (issue #266).
function nodeTypeLabel(type: string): string {
  return isNodeType(type) ? NODE_TYPE_LABELS[type] : type;
}

// Дефолтные inputs теста в виде JSON-текста для расширенного режима (issue #248):
// переиспользует общий источник значений из schemaGraph, чтобы типизированные поля
// и сырой JSON не расходились.
function defaultTestInputs(schemaType: SchemaPaletteKind): string {
  return jsonPreview(defaultTestInputValues(schemaType));
}

// Начальные значения типизированных полей теста (issue #248): берём дефолты по типу
// схемы; JSON-поля сериализуем в строку, остальные берём как есть.
function initialFieldValues(schemaType: SchemaPaletteKind): Record<string, string> {
  const defaults = defaultTestInputValues(schemaType);
  const result: Record<string, string> = {};
  for (const inputField of testInputFields(schemaType)) {
    const value = defaults[inputField.key];
    if (inputField.kind === 'json') {
      result[inputField.key] = value !== undefined ? jsonPreview(value) : '';
    } else {
      result[inputField.key] = typeof value === 'string' ? value : '';
    }
  }
  return result;
}

// Начальные значения полей теста суб-схемы (issue #343): по составу start-узла.
// JSON-поля сериализуем в текст, прочие (строки/числа/булевы) — в простое
// строковое представление дефолта по типу порта.
function initialSubSchemaFieldValues(graph: SchemaGraph): Record<string, string> {
  const defaults = defaultSubSchemaTestInputValues(graph);
  const result: Record<string, string> = {};
  for (const inputField of subSchemaTestInputFields(graph)) {
    const value = defaults[inputField.key];
    if (inputField.kind === 'json') {
      result[inputField.key] = value !== undefined ? jsonPreview(value) : '';
    } else if (typeof value === 'string') {
      result[inputField.key] = value;
    } else if (value === undefined || value === null) {
      result[inputField.key] = '';
    } else {
      result[inputField.key] = String(value);
    }
  }
  return result;
}

// Начальные значения полей изолированного теста тела узла (issue #390): по входным
// data-портам тестируемого узла. JSON-поля сериализуем в текст, прочие — в простое
// строковое представление дефолта по типу порта (как у суб-схем).
function initialNodeBodyFieldValues(node: NodeDefinition, parentGraph: SchemaGraph): Record<string, string> {
  const defaults = defaultNodeBodyTestInputValues(node, parentGraph);
  const result: Record<string, string> = {};
  for (const inputField of nodeBodyTestInputFields(node, parentGraph)) {
    const value = defaults[inputField.key];
    if (inputField.kind === 'json') {
      result[inputField.key] = value !== undefined ? jsonPreview(value) : '';
    } else if (typeof value === 'string') {
      result[inputField.key] = value;
    } else if (value === undefined || value === null) {
      result[inputField.key] = '';
    } else {
      result[inputField.key] = String(value);
    }
  }
  return result;
}

function normalizeLlmPortRows(value: unknown): LlmPortRow[] {
  if (Array.isArray(value)) {
    return value
      .map((row): LlmPortRow | null => {
        if (!isRecord(row)) return null;
        const name = asString(row.name).trim();
        if (!name) return null;
        return {
          name,
          type: asPortType(row.type),
          description: asString(row.description),
          jsonPath: asString(row.jsonPath),
          path: asString(row.path),
        };
      })
      .filter((row): row is LlmPortRow => row !== null);
  }
  if (isRecord(value)) {
    return Object.keys(value).map((name) => ({ name, type: 'any' }));
  }
  return [];
}

function cleanLlmPortRow(row: LlmPortRow): LlmPortRow {
  const clean: LlmPortRow = {
    name: row.name.trim(),
    type: asPortType(row.type),
  };
  if (row.description?.trim()) clean.description = row.description.trim();
  if (row.jsonPath?.trim()) clean.jsonPath = row.jsonPath.trim();
  if (row.path?.trim()) clean.path = row.path.trim();
  return clean;
}

function nextPortName(rows: LlmPortRow[], base: string): string {
  const used = new Set(rows.map((row) => row.name));
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}_${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}_${rows.length + 1}`;
}

function splitComma(value: string): string[] {
  return [...new Set(value.split(',').map((part) => part.trim()).filter(Boolean))];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asPortType(value: unknown): PortType {
  return typeof value === 'string' && (PORT_TYPES as readonly string[]).includes(value) && value !== 'exec'
    ? value as PortType
    : 'any';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Сравнивает два списка id по порядку — чтобы не пересоздавать state выделения,
// когда ReactFlow присылает тот же набор (issue #230).
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
