-- Схема базы данных Telegram LLM RPG Bot (PostgreSQL).
-- Идемпотентна: можно запускать повторно.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Расширение pgvector для семантического поиска документов экспертизы службы
-- поддержки по эмбеддингам (issue #147). Требует образа pgvector/pgvector:pg16.
CREATE EXTENSION IF NOT EXISTS vector;

-- Статусы платежей.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_status') THEN
        CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'failed', 'canceled');
    END IF;
END$$;

-- Статусы обращений в службу поддержки (issue #59, #149, #244):
--   open        — на консультации у LLM-бота первой линии;
--   escalated   — передано оператору, видно администраторам (issue #244);
--   closed      — закрыто администратором;
--   auto_closed — автоматически закрыто ботом, проблема решена (issue #149).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'support_ticket_status') THEN
        CREATE TYPE support_ticket_status AS ENUM ('open', 'escalated', 'closed', 'auto_closed');
    END IF;
END$$;

-- Добавить auto_closed к уже существующему enum (идемпотентно, issue #149).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumtypid = 'support_ticket_status'::regtype
          AND enumlabel = 'auto_closed'
    ) THEN
        ALTER TYPE support_ticket_status ADD VALUE 'auto_closed';
    END IF;
END$$;

-- Добавить escalated к уже существующему enum (идемпотентно, issue #244).
-- Внимание: значение должно быть зафиксировано отдельной транзакцией до его
-- использования в индексах/UPDATE ниже — миграция (src/db/migrate.ts) делает это
-- предварительным запросом, а при запуске schema.sql из psql каждое выражение
-- выполняется в автокоммите, поэтому ограничение PostgreSQL также соблюдается.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumtypid = 'support_ticket_status'::regtype
          AND enumlabel = 'escalated'
    ) THEN
        ALTER TYPE support_ticket_status ADD VALUE 'escalated';
    END IF;
END$$;

-- Кто отправил сообщение в обращении: клиент, администратор или бот-консультант.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'support_sender') THEN
        CREATE TYPE support_sender AS ENUM ('user', 'admin', 'bot');
    END IF;
END$$;

-- Значение 'bot' для уже существующих БД (issue #59): сообщения LLM-консультанта.
ALTER TYPE support_sender ADD VALUE IF NOT EXISTS 'bot';

-- Тип исполняемой JSON-схемы графа (issue #171).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'schema_type') THEN
        CREATE TYPE schema_type AS ENUM ('action', 'hint', 'illustration', 'support');
    END IF;
END$$;

-- Класс суб-схемы (issue #310): задаёт палитру узлов и правила переиспользования.
-- Суб-схема — самостоятельная сущность; вместо schema_type у неё schema_class.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'schema_class') THEN
        CREATE TYPE schema_class AS ENUM ('game', 'support', 'common');
    END IF;
END$$;

-- Манифесты игровых сценариев (issue #106).
-- Сам манифест хранится в JSONB, чтобы новые поля сценария не требовали
-- изменения структуры БД. TypeScript-код хранит только тип GameManifest.
CREATE TABLE IF NOT EXISTS game_manifests (
    game_id    VARCHAR(50) PRIMARY KEY,
    manifest   JSONB       NOT NULL,
    sort_order INTEGER     NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT game_manifests_game_id_format
        CHECK (game_id ~ '^[A-Za-z0-9_-]{1,50}$'),
    CONSTRAINT game_manifests_manifest_id_match
        CHECK (manifest ? 'id' AND (manifest->>'id') = game_id)
);

ALTER TABLE game_manifests
    ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

-- Исполняемые JSON-графы схем (issue #171).
-- Активная схема может быть глобальной (game_id IS NULL) или переопределять
-- поведение конкретной игры. Приложение выбирает активную схему игры, а если её
-- нет — глобальную схему с тем же slug.
CREATE TABLE IF NOT EXISTS schemas (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schema_slug  VARCHAR(100) NOT NULL,
    -- Ровно одно из двух (issue #310): schema_type — пайплайн-схема, schema_class —
    -- суб-схема. Инвариант гарантирует CONSTRAINT schemas_kind_xor.
    schema_type  schema_type  NULL,
    schema_class schema_class NULL,
    game_id      VARCHAR(50)  NULL REFERENCES game_manifests (game_id) ON DELETE CASCADE,
    graph_json   JSONB        NOT NULL,
    is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
    description  TEXT         NOT NULL DEFAULT '',
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    -- draft_graph_json хранит черновик — незафиксированную версию графа.
    -- NULL означает, что черновика нет (черновик совпадает с рабочей версией).
    draft_graph_json JSONB NULL DEFAULT NULL,
    CONSTRAINT schemas_slug_format
        CHECK (schema_slug ~ '^[A-Za-z0-9_-]{1,100}$'),
    CONSTRAINT schemas_kind_xor
        CHECK (num_nonnulls(schema_type, schema_class) = 1)
);

-- Добавить колонку черновика к уже существующим БД (issue #286, идемпотентно).
ALTER TABLE schemas ADD COLUMN IF NOT EXISTS draft_graph_json JSONB NULL DEFAULT NULL;

-- Класс суб-схемы и XOR-инвариант для уже существующих БД (issue #310,
-- идемпотентно). schema_type становится NULL-допустимым (у суб-схем его нет).
ALTER TABLE schemas ADD COLUMN IF NOT EXISTS schema_class schema_class NULL;
ALTER TABLE schemas ALTER COLUMN schema_type DROP NOT NULL;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'schemas_kind_xor'
    ) THEN
        ALTER TABLE schemas ADD CONSTRAINT schemas_kind_xor
            CHECK (num_nonnulls(schema_type, schema_class) = 1);
    END IF;
END$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_schemas_active_unique
    ON schemas (schema_slug, COALESCE(game_id, ''))
    WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_schemas_slug_game_active
    ON schemas (schema_slug, game_id, is_active);

CREATE TABLE IF NOT EXISTS schema_history (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schema_slug        VARCHAR(100) NOT NULL,
    -- Ровно одно из двух как в schemas (issue #310).
    schema_type        schema_type  NULL,
    schema_class       schema_class NULL,
    game_id            VARCHAR(50)  NULL REFERENCES game_manifests (game_id) ON DELETE SET NULL,
    graph_json         JSONB        NOT NULL,
    is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
    description        TEXT         NOT NULL DEFAULT '',
    created_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    version_created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    archived_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Класс суб-схемы в истории для уже существующих БД (issue #310, идемпотентно).
ALTER TABLE schema_history ADD COLUMN IF NOT EXISTS schema_class schema_class NULL;
ALTER TABLE schema_history ALTER COLUMN schema_type DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_schema_history_slug
    ON schema_history (schema_slug, archived_at DESC);

-- Базовые манифесты сценариев: первичная загрузка в новую таблицу.
-- ON CONFLICT DO NOTHING сохраняет правки манифестов, сделанные прямо в БД.
INSERT INTO game_manifests (game_id, manifest, sort_order)
VALUES
    ('bomj', '{"id":"bomj","name":"Выживание бомжа","description":"Вы просыпаетесь на теплотрассе. Карманы пусты, в животе урчит.","priceStars":1,"limits":{"maxHp":100,"maxInventoryItems":10},"worldRules":["Действие происходит в суровом реалистичном городе. Магии не существует.","Каждое физическое действие тратит от 5 до 15 единиц здоровья (HP) из-за голода.","Нефизические действия вроде чтения, разговора, ожидания, отдыха или лечения не обязаны тратить HP, если персонаж не совершает заметной физической нагрузки.","Навыки растут постепенно: обучение, повторные попытки, помощь другого человека и успешная практика накапливаются между ходами и могут повысить релевантный навык на 1.","Игрок не может находить дорогие вещи (машины, огнестрел, миллион рублей) на помойке.","Время мира идёт вперёд: за ночь холодает, осенью и зимой выжить на улице труднее, а ночью опаснее и холоднее, чем днём.","Если HP падает до 0, игра мгновенно завершается поражением."],"startTime":{"season":"осень","date":"14 октября","time":"08:00","time_of_day":"утро"},"characterPresets":[{"name":"Игорь — бывший инженер","description":"Игорь когда-то проектировал заводские станки, но после развода и долгов оказался на улице. Голова у него по-прежнему светлая: он умеет чинить, считать и находить нестандартные решения, но воля надломлена, а руки отвыкли от тяжёлой работы.","character":{"hp":75,"max_hp":100,"skills":{"смекалка":3,"выживание":1},"inventory":["треснутые очки","затёртый блокнот с расчётами"]}},{"name":"Витёк — пройдоха","description":"Витёк живёт на улице уже много лет и знает её как свои пять пальцев. Где раздают бесплатный суп, в какой подворотне можно переночевать, у кого что плохо лежит — он в курсе всего. Хитрый, верткий и не брезгливый, но здоровье уже подводит.","character":{"hp":70,"max_hp":100,"skills":{"попрошайничество":3,"воровство":2,"выживание":2},"inventory":["мятая шапка для подаяний","перочинный нож"]}},{"name":"Клава — добрая душа","description":"Клава — немолодая женщина, бывшая повариха из заводской столовой. Оказавшись на улице, она не растеряла теплоты: умеет разговорить кого угодно, выпросить еды по-доброму и приготовить сытное варево из того, что найдёт.","character":{"hp":80,"max_hp":100,"skills":{"общение":3,"готовка":2},"inventory":["закопчённый котелок","щепотка соли в тряпице"]}},{"name":"Маша — беглянка","description":"Маша сбежала из детдома и привыкла полагаться только на себя. Молодая, шустрая и ловкая, она легко пролезет в любую щель и быстро убежит от беды, но городскую жизнь знает плохо и бывает наивна.","character":{"hp":85,"max_hp":100,"skills":{"ловкость":3,"скрытность":2},"inventory":["потрёпанный рюкзачок","недоеденная шоколадка"]}}],"locationPresets":[{"location":"Теплотрасса на окраине города","narrative":"Вы просыпаетесь на тёплых трубах теплотрассы. Голова гудит, в животе урчит от голода. Рядом валяется старая газета и пустая бутылка. Что будете делать?"},{"location":"Под мостом у дорожной развязки","narrative":"Вы устроились на ночлег под бетонным мостом у шумной развязки. Над головой нескончаемо гудят машины, ветер несёт пыль и обрывки газет. Неподалёку тлеет чужой костёр, у которого греются такие же бедолаги. Что будете делать?"},{"location":"В подвале заброшенного дома","narrative":"Вы очнулись в сыром подвале заброшенного дома. Пахнет плесенью, сквозь щель в фундаменте сочится тусклый дневной свет. В углу — груда тряпья и ржавая труба. Где-то наверху скрипят половицы. Что будете делать?"}]}'::jsonb, 1),
    ('red_hood', '{"id":"red_hood","name":"Приключения Красной Шапочки","description":"Бабушка заболела, и ты несёшь ей пирожки через дремучий лес. Но в лесу водится Серый Волк…","priceStars":1,"limits":{"maxHp":100,"maxInventoryItems":10},"worldRules":["Действие происходит в сказочном лесу и деревне. Здесь возможна лёгкая магия и говорящие звери.","Каждое опасное или трудное физическое действие тратит от 5 до 15 единиц здоровья (HP).","Безопасные действия вроде разговора, отдыха, еды и лечения не обязаны тратить HP.","Навыки растут постепенно: обучение, повторные попытки и помощь других персонажей могут повысить релевантный навык на 1.","Нельзя находить мощное современное оружие — только сказочные предметы и простые инструменты.","Время мира идёт вперёд: к ночи лес становится темнее и опаснее, а путь до бабушки занимает время.","Если HP падает до 0, игра мгновенно завершается поражением."],"startTime":{"season":"лето","date":"7 июля","time":"07:00","time_of_day":"утро"},"characterPresets":[{"name":"Красная Шапочка — дерзкая и смелая","description":"Эта Красная Шапочка ничего не боится и за словом в карман не лезет. Она готова идти напролом, постоять за себя и даже подразнить Волка. Смелость её выручает, но иногда заводит туда, где осторожный давно бы повернул назад.","character":{"hp":95,"max_hp":100,"skills":{"храбрость":3,"хитрость":1},"inventory":["корзинка с пирожками","крепкая палка-посох"]}},{"name":"Красная Шапочка — осторожная и трусоватая","description":"Эта Красная Шапочка всего опасается и тысячу раз подумает, прежде чем сделать шаг. Зато она внимательна к мелочам, замечает следы и подозрительные шорохи и редко попадает впросак. Главное — не растеряться от собственного страха.","character":{"hp":85,"max_hp":100,"skills":{"осторожность":3,"внимательность":2},"inventory":["корзинка с пирожками","оберег от бабушки"]}},{"name":"Красная Шапочка — всезнайка","description":"Эта Красная Шапочка прочитала все книжки в деревне и знает всё на свете: какие травы лечат, как зовут всех зверей и о чём поётся в старых сказках. Беда лишь в том, что руками она почти ничего не умеет — теория есть, а сноровки нет.","character":{"hp":80,"max_hp":100,"skills":{"эрудиция":3,"ловкость":1},"inventory":["корзинка с пирожками","потрёпанная книга сказок"]}}],"locationPresets":[{"location":"Опушка сказочного леса","narrative":"Мама попрощалась с тобой у калитки: «Красная Шапочка, отнеси бабушке пирожки и горшочек масла — она приболела!» Тропинка уходит в тёмный дремучий лес. Где-то вдали слышится вой. Что будешь делать?"},{"location":"Развилка трёх лесных тропинок","narrative":"Ты заходишь поглубже в лес и оказываешься на развилке: одна тропинка ведёт через светлую поляну, другая — мимо мрачного оврага, а третья ныряет в густой ельник. На покосившемся столбе висит старая табличка, но буквы стёрлись. Откуда-то доносится осторожный хруст веток. Что будешь делать?"}]}'::jsonb, 2),
    ('private_detective', '{"id":"private_detective","name":"Частный детектив","description":"В дождливом городе пропал человек, полиция закрывает глаза на детали, а улики ведут к влиятельным людям.","priceStars":1,"limits":{"maxHp":100,"maxInventoryItems":10},"worldRules":["Действие происходит в современном реалистичном городе. Магии, мистики и сверхспособностей не существует.","Расследование строится на уликах, свидетельских показаниях, мотивах и проверяемых версиях.","Нельзя мгновенно назвать виновного, найти неопровержимую улику или раскрыть дело без действий игрока.","Незаконное насилие, взлом и угрозы могут привлечь полицию, испугать свидетелей или уничтожить доверие клиента.","Опасные физические действия, драки, погони и ранения тратят от 5 до 20 единиц здоровья (HP).","Безопасные действия вроде разговора, анализа документов, наблюдения и отдыха не обязаны тратить HP.","Навыки растут постепенно: удачные допросы, изучение улик и рискованные вылазки могут повысить релевантный навык на 1.","Время мира идёт вперёд: ночью меньше свидетелей и открытых учреждений, зато проще скрытно наблюдать.","Если HP падает до 0, игра мгновенно завершается поражением."],"startTime":{"season":"осень","date":"21 октября","time":"18:30","time_of_day":"вечер"},"characterPresets":[{"name":"Артём Волков — бывший опер","description":"Артём десять лет служил в уголовном розыске, пока не ушёл после дела, которое слишком быстро закрыли сверху. Он умеет читать протоколы, давить на мелких жуликов и держать удар, но официальных рычагов у него больше нет.","character":{"hp":90,"max_hp":100,"skills":{"допрос":3,"наблюдательность":2,"рукопашный_бой":1},"inventory":["потрёпанное удостоверение частного детектива","карманный фонарик"]}},{"name":"Лиза Орлова — журналистка-расследовательница","description":"Лиза писала громкие материалы о коррупции, пока редакция не испугалась очередного иска. Она знает, как разговорить человека, найти старую публикацию и проследить за целью так, чтобы не спугнуть её.","character":{"hp":85,"max_hp":100,"skills":{"общение":3,"поиск_информации":2,"скрытность":1},"inventory":["диктофон","блокнот с контактами"]}},{"name":"Семён Крайнов — криминалист на вольных хлебах","description":"Семён раньше работал экспертом при лаборатории, но ушёл после конфликта с начальством. Он осторожен, педантичен и лучше других замечает отпечатки, следы ремонта и мелкие несостыковки в вещах.","character":{"hp":80,"max_hp":100,"skills":{"криминалистика":3,"техника":2,"внимательность":2},"inventory":["набор для снятия отпечатков","складная лупа"]}}],"locationPresets":[{"location":"Офис над круглосуточной типографией","narrative":"Вечерний дождь барабанит по жестяному козырьку, а под полом гудят печатные станки типографии. На столе лежит конверт с авансом, фотография пропавшего адвоката и записка его жены: «Полиция говорит, что он просто уехал. Я в это не верю». Что будете делать?"},{"location":"Двор за театром «Паллада»","narrative":"За театром пахнет мокрым асфальтом, гримом и дешёвым табаком. У служебного входа спорят двое рабочих, а под пожарной лестницей блестит в луже сломанная запонка — такая же, как на фотографии пропавшего. Что будете делать?"},{"location":"Камера хранения старого вокзала","narrative":"Старый вокзал шумит объявлениями и поздними электричками. В SMS от неизвестного номера указан ряд ячеек, но нужная дверца поцарапана свежим ключом, а рядом уже крутится человек в сером плаще. Что будете делать?"}]}'::jsonb, 3)
ON CONFLICT (game_id) DO NOTHING;
-- Справочник групп сценариев (issue #100).
-- Игрок может состоять в нескольких группах; каждая группа открывает набор игр.
CREATE TABLE IF NOT EXISTS game_groups (
    group_id   VARCHAR(50) PRIMARY KEY,
    game_ids   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT game_groups_group_id_format
        CHECK (group_id ~ '^[A-Za-z0-9_-]{1,50}$')
);

-- Базовая группа сохраняет прежнее поведение: новый игрок видит все текущие сценарии.
INSERT INTO game_groups (group_id, game_ids)
SELECT 'default', COALESCE(array_agg(game_id ORDER BY sort_order, game_id), ARRAY[]::TEXT[])
FROM game_manifests
ON CONFLICT (group_id) DO NOTHING;

-- Пользователи Telegram.
CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id BIGINT       NOT NULL UNIQUE,
    username    VARCHAR(255),
    is_tester   BOOLEAN      NOT NULL DEFAULT FALSE,
    is_admin    BOOLEAN      NOT NULL DEFAULT FALSE,
    groups      TEXT[]       NOT NULL DEFAULT ARRAY['default']::TEXT[],
    game_ids    TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Флаг администратора службы поддержки (для существующих БД).
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Группы и кеш доступных игр игрока (issue #100) для существующих БД.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS groups TEXT[] NOT NULL DEFAULT ARRAY['default']::TEXT[];

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS game_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE users
    ALTER COLUMN game_ids SET DEFAULT ARRAY[]::TEXT[];

UPDATE users
SET groups = ARRAY['default']::TEXT[]
WHERE groups IS NULL OR array_length(groups, 1) IS NULL;

UPDATE users u
SET game_ids = COALESCE((
    SELECT array_agg(DISTINCT gid.game_id ORDER BY gid.game_id)
    FROM game_groups gg
    CROSS JOIN LATERAL unnest(gg.game_ids) AS gid(game_id)
    WHERE gg.group_id = ANY(u.groups)
), ARRAY[]::TEXT[]);

-- Игровые сессии.
-- 1 USD = 100 центов = 100 000 миллицентов.
CREATE TABLE IF NOT EXISTS game_sessions (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id              VARCHAR(50)  NOT NULL,
    user_id              UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    is_active            BOOLEAN      NOT NULL DEFAULT TRUE,
    is_processing        BOOLEAN      NOT NULL DEFAULT FALSE,
    current_state        JSONB        NOT NULL,
    allocated_millicents BIGINT       NOT NULL DEFAULT 0,
    used_credits         INTEGER      NOT NULL DEFAULT 0,
    cost_millicents      BIGINT       NOT NULL DEFAULT 0,
    token_usage          JSONB        NOT NULL DEFAULT '{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheCreationTokens":0}'::jsonb,
    created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_game_sessions_user_active
    ON game_sessions (user_id, is_active);

-- Внешний ключ на текущую сессию добавляется после создания game_sessions.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS active_session_id UUID
        REFERENCES game_sessions (id) ON DELETE SET NULL;

-- Пользовательские настройки медиа (issue #81).
-- Провайдер здесь не хранится: пользователь настраивает только модели и
-- параметры в рамках MEDIA_PROVIDER проекта. При смене провайдера старые
-- значения игнорируются приложением, если их нет в каталоге текущего провайдера.
CREATE TABLE IF NOT EXISTS user_media_configs (
    user_id     UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    tts_model   VARCHAR(100),
    tts_voice   VARCHAR(100),
    image_model VARCHAR(100),
    image_size  VARCHAR(50),
    updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Шаги (ходы) внутри сессии.
-- is_cancelled — ход отменён командой /cancel (issue #116): он не попадает в
-- память для промптов LLM, но сохраняется и выгружается в истории с пометкой.
-- state_before — снимок состояния сессии ДО применения хода: позволяет по
-- команде /cancel откатывать ходы по одному (восстанавливая прежнее состояние).
CREATE TABLE IF NOT EXISTS game_steps (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id       UUID         NOT NULL REFERENCES game_sessions (id) ON DELETE CASCADE,
    action_text      TEXT,
    llm_raw_response TEXT,
    changes_summary  TEXT,
    cost_millicents  BIGINT       NOT NULL DEFAULT 0,
    step_credits     INTEGER      NOT NULL DEFAULT 0,
    token_usage      JSONB        NOT NULL DEFAULT '{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheCreationTokens":0}'::jsonb,
    is_cancelled     BOOLEAN      NOT NULL DEFAULT FALSE,
    state_before     JSONB,
    created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Колонки отмены хода для уже существующих БД (issue #116).
ALTER TABLE game_steps
    ADD COLUMN IF NOT EXISTS is_cancelled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE game_steps
    ADD COLUMN IF NOT EXISTS state_before JSONB;

CREATE INDEX IF NOT EXISTS idx_game_steps_session
    ON game_steps (session_id);

-- Журнал запусков схем (issue #171). Пишется лучшим усилием и хранит входы,
-- выходы и LLM-аудит конкретного исполнения графа.
CREATE TABLE IF NOT EXISTS schema_execution_log (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schema_slug  VARCHAR(100) NOT NULL,
    game_id      VARCHAR(50)  NULL REFERENCES game_manifests (game_id) ON DELETE SET NULL,
    session_id   UUID         NULL REFERENCES game_sessions (id) ON DELETE SET NULL,
    inputs_json  JSONB        NOT NULL DEFAULT '{}'::jsonb,
    outputs_json JSONB        NOT NULL DEFAULT '{}'::jsonb,
    llm_log      JSONB        NOT NULL DEFAULT '[]'::jsonb,
    duration_ms  INTEGER     NOT NULL DEFAULT 0,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Поля статуса и деталей ошибки (issue #255, этап F). После удаления legacy
-- ошибка исполнения (нет активной схемы, падение узла) доставляется
-- пользователю, поэтому оператору нужен просмотр таких случаев в админке.
-- Колонки добавляются идемпотентно, чтобы накатывать на существующую БД.
ALTER TABLE schema_execution_log
    ADD COLUMN IF NOT EXISTS schema_type     schema_type  NULL,
    -- schema_class — для журналирования исполнения суб-схемы как корня (issue #310).
    ADD COLUMN IF NOT EXISTS schema_class    schema_class NULL,
    ADD COLUMN IF NOT EXISTS status          VARCHAR(10)  NOT NULL DEFAULT 'ok',
    ADD COLUMN IF NOT EXISTS error_node_id   VARCHAR(200) NULL,
    ADD COLUMN IF NOT EXISTS error_node_type VARCHAR(100) NULL,
    ADD COLUMN IF NOT EXISTS error_message   TEXT         NULL,
    ADD COLUMN IF NOT EXISTS error_last_raw  TEXT         NULL;

CREATE INDEX IF NOT EXISTS idx_schema_execution_log_schema
    ON schema_execution_log (schema_slug, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_schema_execution_log_session
    ON schema_execution_log (session_id, created_at DESC);

-- Быстрый отбор свежих ошибок (счётчик/подсветка в админке, этап F).
CREATE INDEX IF NOT EXISTS idx_schema_execution_log_status
    ON schema_execution_log (status, created_at DESC);

-- Фильтр журнала по типу схемы (этап F).
CREATE INDEX IF NOT EXISTS idx_schema_execution_log_type
    ON schema_execution_log (schema_type, created_at DESC);

-- Журнал платежей (Telegram Stars).
CREATE TABLE IF NOT EXISTS payment_logs (
    id                 UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID           NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    session_id         UUID           REFERENCES game_sessions (id) ON DELETE SET NULL,
    amount             INTEGER        NOT NULL,
    status             payment_status NOT NULL DEFAULT 'pending',
    telegram_charge_id VARCHAR(255),
    payload            JSONB,
    created_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_logs_user
    ON payment_logs (user_id);

-- ============================================================================
-- Служба поддержки (issue #57)
-- ============================================================================

-- Обращения клиентов («топики»). number — человекочитаемый номер #nnn.
-- last_message_at хранит дату последнего сообщения в обращении.
-- escalated_at — момент передачи обращения администратору (issue #59).
-- Пока NULL, обращение находится на консультации у LLM-бота первой линии
-- и не показывается администраторам.
CREATE TABLE IF NOT EXISTS support_tickets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    number          BIGINT       NOT NULL GENERATED ALWAYS AS IDENTITY,
    user_id         UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status          support_ticket_status NOT NULL DEFAULT 'open',
    last_message_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    escalated_at    TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Колонка escalated_at для уже существующих БД (issue #59).
ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMP WITH TIME ZONE;

-- Перенос ранее эскалированных обращений на отдельный статус (issue #244):
-- до появления статуса escalated переданные оператору обращения отличались от
-- открытых только проставленным escalated_at — переводим их в новый статус.
UPDATE support_tickets
    SET status = 'escalated'
    WHERE status = 'open' AND escalated_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_support_tickets_number
    ON support_tickets (number);

-- Не более одного активного обращения на пользователя. Активны статусы open
-- (консультация) и escalated (передано оператору, issue #244). Старый индекс по
-- одному статусу open удаляем явно — CREATE INDEX IF NOT EXISTS не меняет предикат.
DROP INDEX IF EXISTS idx_support_tickets_user_open;
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_tickets_user_active
    ON support_tickets (user_id)
    WHERE status IN ('open', 'escalated');

-- Сообщения внутри обращения (от клиента и от администратора).
CREATE TABLE IF NOT EXISTS support_messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id   UUID           NOT NULL REFERENCES support_tickets (id) ON DELETE CASCADE,
    sender      support_sender NOT NULL,
    sender_id   UUID           REFERENCES users (id) ON DELETE SET NULL,
    text        TEXT           NOT NULL,
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_messages_ticket
    ON support_messages (ticket_id, created_at);

-- ============================================================================
-- Аудит запросов к LLM и медиа-моделям (issue #83)
-- ============================================================================

-- Один ряд = один фактический запрос к модели. Источник запроса описывается
-- слагом схемы и идентификатором узла (issue #403): по ним лог фильтруется и
-- сопоставляется со схемой/узлом. У не-схемных запросов (озвучка, иллюстрация,
-- распознавание речи) схемы нет — schema_slug/node_id остаются NULL.
CREATE TABLE IF NOT EXISTS llm_request_logs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID REFERENCES users (id) ON DELETE SET NULL,
    session_id        UUID REFERENCES game_sessions (id) ON DELETE SET NULL,
    step_id           UUID REFERENCES game_steps (id) ON DELETE SET NULL,
    support_ticket_id UUID REFERENCES support_tickets (id) ON DELETE SET NULL,
    schema_slug       VARCHAR(100),
    node_id           VARCHAR(200),
    provider          VARCHAR(50)  NOT NULL,
    model             VARCHAR(255) NOT NULL,
    model_params      JSONB        NOT NULL DEFAULT '{}'::jsonb,
    request_text      TEXT         NOT NULL,
    response_text     TEXT,
    error_text        TEXT,
    token_usage       JSONB        NOT NULL DEFAULT '{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheCreationTokens":0}'::jsonb,
    cost_millicents   BIGINT       NOT NULL DEFAULT 0,
    -- Документы экспертизы, извлечённые семантическим поиском по эмбеддингам для
    -- данного запроса (issue #147). Массив объектов {id, title, matchedSource,
    -- distance, similarity}. NULL — поиск экспертизы не выполнялся.
    retrieved_documents JSONB,
    created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Колонка извлечённых документов экспертизы для уже существующих БД (issue #147).
ALTER TABLE llm_request_logs
    ADD COLUMN IF NOT EXISTS retrieved_documents JSONB;

-- Источник запроса: схема и узел (issue #403) для уже существующих БД.
ALTER TABLE llm_request_logs
    ADD COLUMN IF NOT EXISTS schema_slug VARCHAR(100);
ALTER TABLE llm_request_logs
    ADD COLUMN IF NOT EXISTS node_id VARCHAR(200);

CREATE INDEX IF NOT EXISTS idx_llm_request_logs_created
    ON llm_request_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_llm_request_logs_session
    ON llm_request_logs (session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_llm_request_logs_step
    ON llm_request_logs (step_id, created_at);

CREATE INDEX IF NOT EXISTS idx_llm_request_logs_support_ticket
    ON llm_request_logs (support_ticket_id, created_at);

-- Фильтрация логов по схеме-источнику запроса (issue #403).
CREATE INDEX IF NOT EXISTS idx_llm_request_logs_schema
    ON llm_request_logs (schema_slug, created_at);

-- ============================================================================
-- Алиасы моделей Azure OpenAI (issue #120)
-- ============================================================================
-- В Azure OpenAI поле `model` в запросе к Chat Completions — это имя deployment
-- (алиас), которое пользователь задаёт сам, а не каноническое имя модели. Из-за
-- этого справочник цен MODEL_PRICING не находит модель по алиасу, и стоимость
-- запроса в миллицентах считается нулевой. Эта таблица сопоставляет алиас
-- (deployment) канонической модели, чтобы при провайдере Azure перед расчётом
-- расхода миллицентов определить реальную модель и её цену.
CREATE TABLE IF NOT EXISTS azure_models (
    alias      VARCHAR(255) PRIMARY KEY,
    model      VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- ============================================================================
-- Глобальные модели по умолчанию (issue #345)
-- ============================================================================
-- После перехода действий на схемы оркестратора нет отдельных hardcoded фаз с
-- разными моделями. Настраиваются только два глобальных default-а:
--   * llm_model_name  — модель/деплоймент для всех текстовых LLM-запросов;
--   * embedding_model — каноническая модель эмбеддингов.
-- Если строки нет, приложение использует значения из .env.
CREATE TABLE IF NOT EXISTS model_defaults (
    key        VARCHAR(50) PRIMARY KEY,
    value      VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT model_defaults_key_check
        CHECK (key IN ('llm_model_name', 'embedding_model'))
);

-- ============================================================================
-- История версий манифестов и промптов (issue #125)
-- ============================================================================
-- При изменении манифеста игры или текста промпта через админку прежняя версия
-- архивируется сюда. Это позволяет на странице редактирования показать, сколько
-- версий накоплено, и просмотреть любую прошлую версию в модальном окне.
-- version_created_at — момент, когда архивируемая версия была сохранена
-- (прежний updated_at записи), archived_at — момент архивации (создания строки).

CREATE TABLE IF NOT EXISTS game_manifest_history (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id            VARCHAR(50)  NOT NULL,
    manifest           JSONB        NOT NULL,
    version_created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    archived_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_game_manifest_history_game
    ON game_manifest_history (game_id, archived_at DESC);

-- Состояние прочтения по администраторам и обращениям.
-- last_message_date — момент, до которого администратор прочитал обращение.
-- Отсутствие строки означает, что администратор ещё не открывал тему.
CREATE TABLE IF NOT EXISTS support_admin_ticket_reads (
    admin_id          UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    ticket_id         UUID NOT NULL REFERENCES support_tickets (id) ON DELETE CASCADE,
    last_message_date TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (admin_id, ticket_id)
);

-- Текущее («активное») обращение администратора: входящие ответы уходят в него.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS active_support_ticket_id UUID
        REFERENCES support_tickets (id) ON DELETE SET NULL;

DROP TABLE IF EXISTS model_rules;

-- ============================================================================
-- Экспертиза службы поддержки по эмбеддингам (issue #147)
-- ============================================================================
-- Документ экспертизы = единица знаний первой линии поддержки. title виден
-- администратору, content подставляется в промпт консультанта, а массив
-- embedding_sources — это поисковые фразы, по которым строятся эмбеддинги
-- (отдельная строка на фразу в expertise_document_embeddings). Бот СП на стадии
-- 1 формулирует проблемы клиента, считает их эмбеддинги и через косинусную
-- близость подтягивает релевантные документы в промпт стадии 2.

CREATE TABLE IF NOT EXISTS expertise_documents (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title             TEXT NOT NULL,
    content           TEXT NOT NULL,
    embedding_sources TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Привязка документа к игре (issue #154). game_id IS NULL — документ службы
-- поддержки (исходное поведение); game_id = '<игра>' — документ базы знаний
-- этой игры. Поиск фильтруется по scope: поддержка ищет среди NULL, игровая
-- фаза 0 — среди документов своей игры.
ALTER TABLE expertise_documents
    ADD COLUMN IF NOT EXISTS game_id VARCHAR(50) NULL
        REFERENCES game_manifests (game_id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_expertise_documents_game
    ON expertise_documents (game_id);

-- Семантические тэги документа (issue #321). Свободный набор строковых меток,
-- по которым узел knowledge_query может сузить область поиска (вход tags):
-- если в запросе заданы тэги, ищутся только документы, чьи tags пересекаются с
-- ними (оператор массивов `&&`). Пустой массив тэгов в запросе — поиск без
-- фильтра (исходное поведение). GIN-индекс ускоряет проверку пересечения.
ALTER TABLE expertise_documents
    ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX IF NOT EXISTS idx_expertise_documents_tags
    ON expertise_documents USING gin (tags);

-- Эмбеддинги поисковых фраз документа (одна строка на фразу). Размерность 1536
-- соответствует модели OpenAI text-embedding-3-small. При изменении документа
-- строки эмбеддингов пересоздаются целиком.
CREATE TABLE IF NOT EXISTS expertise_document_embeddings (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID         NOT NULL REFERENCES expertise_documents (id) ON DELETE CASCADE,
    source      TEXT         NOT NULL,
    embedding   vector(1536) NOT NULL,
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expertise_document_embeddings_document
    ON expertise_document_embeddings (document_id);

-- HNSW-индекс по косинусной близости для приближённого поиска ближайших соседей.
CREATE INDEX IF NOT EXISTS idx_expertise_document_embeddings_vector
    ON expertise_document_embeddings USING hnsw (embedding vector_cosine_ops);

-- ============================================================================
-- Журнал поисковых запросов к экспертизе (issue #156)
-- ============================================================================
-- Один ряд = одна семантическая фраза поиска (ключ ситуации фазы 0 игры или
-- сформулированная проблема клиента в боте поддержки), по которой выполнялся
-- векторный поиск документов экспертизы. Хранится текст запроса, его эмбеддинг
-- (для фильтра «семантически близкие запросы» в аналитике), найденные документы
-- с их близостью и лучшая близость лучшего совпадения (для фильтра по качеству
-- совпадения). game_id повторяет область поиска: NULL — служба поддержки,
-- иначе — база знаний конкретной игры.
CREATE TABLE IF NOT EXISTS expertise_search_queries (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id             VARCHAR(50) NULL
                            REFERENCES game_manifests (game_id) ON DELETE CASCADE,
    query_text          TEXT         NOT NULL,
    embedding           vector(1536) NOT NULL,
    -- Лучшая косинусная близость среди найденных документов (1 - distance).
    -- NULL — документов не найдено (пустая выборка под этот запрос).
    best_similarity     DOUBLE PRECISION,
    result_count        INTEGER      NOT NULL DEFAULT 0,
    -- Найденные документы [{id, title, matchedSource, distance, similarity}].
    retrieved_documents JSONB,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expertise_search_queries_created
    ON expertise_search_queries (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_expertise_search_queries_game
    ON expertise_search_queries (game_id);

-- HNSW-индекс по косинусной близости для фильтра «семантически близкие запросы».
CREATE INDEX IF NOT EXISTS idx_expertise_search_queries_vector
    ON expertise_search_queries USING hnsw (embedding vector_cosine_ops);

-- Долговременная память игры (issue #166).
-- Важные факты о ходе игры и состоянии мира, выделенные отдельной LLM-фазой
-- в конце хода, сохраняются ячейками памяти и по необходимости подключаются в
-- промпт нарратива (плейсхолдер {{memory}}). В отличие от world_flags (только
-- булевы) и окна истории (последние ходы), ячейки хранят свободный текст и
-- переживают окно истории. Привязка к шагу (step_id) позволяет удалять ячейки
-- отменённого хода по команде /cancel вместе с самим шагом.
CREATE TABLE IF NOT EXISTS game_memory_cells (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id   UUID         NOT NULL REFERENCES game_sessions (id) ON DELETE CASCADE,
    step_id      UUID         REFERENCES game_steps (id) ON DELETE CASCADE,
    content      TEXT         NOT NULL,
    category     VARCHAR(50)  NOT NULL DEFAULT '',
    importance   SMALLINT     NOT NULL DEFAULT 1,
    turn_created INTEGER      NOT NULL DEFAULT 0,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_game_memory_cells_session
    ON game_memory_cells (session_id);

CREATE INDEX IF NOT EXISTS idx_game_memory_cells_step
    ON game_memory_cells (step_id);
