# ZaliMessenger — Полное описание визуального дизайна

> Единый справочник по внешнему виду интерфейса: токены, компоненты, состояния, анимации, правила.

---

## 1. Философия

**Cyber-Glass** — так называется визуальный язык Zali. Три столпа:

| Столп | Суть |
|---|---|
| **Глубина** | Слои, тени, backdrop-blur, полупрозрачность создают ощущение пространства |
| **Контраст** | Абсолютная тьма фона против точечного неонового акцента |
| **Минимализм** | Ничего декоративного. Каждый элемент несёт функцию |

Интерфейс должен ощущаться как **профессиональный инструмент**, а не как витрина. Технический, собранный, прямой.

### Что запрещено

- Светлые панели и белые карточки в SaaS-стиле
- Декоративные орбы, bokeh, пастельные градиенты
- Анимации ради анимаций
- Лишние акцентные цвета помимо lime и red
- Маркетинговые формулировки в UI-тексте

---

## 2. Цветовая система

### CSS-токены (`:root`)

```css
--lime:       #cbff00                    /* Zali Lime — единственный яркий акцент */
--lime-dim:   rgba(203,255,0,.10)        /* Подсветка focus-ring */
--lime-glow:  rgba(203,255,0,.25)        /* Свечение активных элементов */
--lime-soft:  rgba(203,255,0,.06)        /* Очень мягкий lime-фон */
--bg:         #090b0e                    /* Основной фон приложения */
--sidebar:    rgba(11,13,16,.90)         /* Фон сайдбара */
--text:       #f2f2f2                    /* Основной текст */
--text2:      rgba(255,255,255,.50)      /* Вторичный текст, подписи */
--text3:      rgba(255,255,255,.25)      /* Третичный текст, disabled */
--border:     rgba(255,255,255,.07)      /* Тонкие рамки */
--red:        #ff4d6d                    /* Ошибки, деструктивные действия */
--accent-rgb: 203,255,0                  /* RGB-значение lime для rgba() */
```

### Семантика цветов

| Роль | Цвет | Применение |
|---|---|---|
| Primary CTA | `#cbff00` | Основные кнопки, активные состояния, focus ring |
| Background | `#090b0e` | Фон всего приложения |
| Glass surface | `rgba(255,255,255,.03)` | Карточки, панели, сайдбар |
| Glass border | `rgba(255,255,255,.07–.09)` | Рамки всех панелей |
| Text primary | `#f2f2f2` | Заголовки, основной контент |
| Text secondary | `rgba(255,255,255,.50)` | Метаданные, подписи, placeholder |
| Text muted | `rgba(255,255,255,.25)` | Disabled, nav-labels |
| Danger | `#ff4d6d` | Ошибки, кнопки удаления, ws-dot offline |
| Success accent | `#cbff00` | ws-dot online, статусы успеха |

### Использование lime

Lime (`#cbff00`) — редкий и точный акцент:
- **Только там, где нужен первичный сигнал**: активная кнопка, focus, онлайн-статус, активный пункт меню
- Нигде не используется как фоновый или декоративный цвет
- Текст на lime-фоне всегда чёрный (`#050505`)

---

## 3. Фоновая среда

Фон приложения — не просто `#090b0e`. Это многослойная среда:

```css
.app {
    background:
        radial-gradient(circle at 16% 12%, rgba(203,255,0,.12), transparent 22%),
        radial-gradient(circle at 72% 18%, rgba(255,255,255,.05), transparent 18%),
        radial-gradient(circle at 50% 120%, rgba(203,255,0,.08), transparent 28%),
        #090b0e;
}
```

**Слои:**
1. Мягкое lime-свечение в левом верхнем углу (12% opacity)
2. Белый блик в правом верхнем углу (5% opacity)
3. Слабое lime-свечение снизу (8% opacity)
4. Базовый почти-чёрный фон

Поверх — тонкая сетка `64×64px` из белых линий `rgba(255,255,255,.015)`, скрытая к краям через radial-mask. Opacity сетки: `0.35`. Она добавляет техническую текстуру без отвлечения.

---

## 4. Типографика

### Шрифтовой стек

```css
font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text",
             "Segoe UI", system-ui, sans-serif;
```

Системный шрифт. На macOS — SF Pro, на Windows — Segoe UI. Никаких загружаемых шрифтов.

### Иерархия

| Роль | Размер | Вес | Особенности |
|---|---|---|---|
| Логотип / H1 | 20px | 900 | `letter-spacing: .02em` |
| Заголовок секции | 14–16px | 800–900 | — |
| Nav label | 11px | 800 | `text-transform: uppercase` |
| Body | 14px | 400–500 | `line-height: 1.5` |
| Meta / hint | 11–12px | 400 | цвет `--text2` |
| Кнопки (segment/mode) | 10–12px | 900–950 | `text-transform: uppercase`, `letter-spacing: .08em` |
| Mono (хэши, пути) | системный mono | — | для технических данных |

### Правила

- `letter-spacing` не отрицательный нигде
- Заголовки в капсе только в nav-labels и кнопках навигации — не в контенте
- Placeholder текст: `--text2` (`rgba(255,255,255,.50)`)
- Disabled текст: `--text3` (`rgba(255,255,255,.25)`)

---

## 5. Layout — общая структура

```
┌──────────────────────────────────────────────────────┐
│  TITLEBAR (40px)                                     │
│  logo · status · ws-pill                            │
├────────────┬─────────────────────────────────────────┤
│            │                                         │
│  SIDEBAR   │  MAIN CONTENT                           │
│  (280px)   │  (flex: 1)                              │
│            │                                         │
│  • hub nav │  • chat view                            │
│  • search  │  • auth screen                          │
│  • list    │  • settings                             │
│            │                                         │
└────────────┴─────────────────────────────────────────┘
```

```css
.app {
    display: grid;
    grid-template-rows: 40px 1fr;
}

.body {
    display: grid;
    grid-template-columns: 280px 1fr;
    gap: 16px;
    padding: 16px;
}
```

Зазор между сайдбаром и основной зоной: `16px`. Внешние отступы от краёв окна: `16px`.

---

## 6. Titlebar

Высота: **40px**. Трёхколоночная сетка `220px / 1fr / 220px`.

```css
.titlebar {
    background: linear-gradient(180deg, rgba(255,255,255,.04), rgba(0,0,0,.22));
    backdrop-filter: blur(16px);
    border-bottom: 1px solid var(--border);
}
```

**Содержимое:**
- **Левая часть**: логотип + навигация / кнопка мобильного меню
- **Центр**: название активного чата (цвет `--text2`, 12px, uppercase) с lime-акцентом на имени собеседника (`--lime`)
- **Правая часть**: ws-pill — индикатор соединения

### WS-pill (индикатор WebSocket)

```
● Online   или   ● Offline
```

```css
.ws-pill {
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: rgba(255,255,255,.03);
    font-size: 11px;
    font-weight: 700;
}
```

- Dot онлайн: `background: #cbff00`, `box-shadow: 0 0 12px rgba(203,255,0,.25)` — живое зелёное свечение
- Dot офлайн: `background: #ff4d6d`, `box-shadow: 0 0 12px rgba(255,77,109,.6)` — красное свечение

---

## 7. Сайдбар

```css
.sidebar {
    border: 1px solid var(--border);
    border-radius: 18px;
    background:
        linear-gradient(180deg, rgba(255,255,255,.025), rgba(255,255,255,.01)),
        rgba(11,13,16,.90);
    box-shadow: 0 14px 36px rgba(0,0,0,.14), inset 0 1px 0 rgba(255,255,255,.02);
    backdrop-filter: blur(8px);
}
```

Radius: `18px`. Стекло с тёмным подтоном, тонкая верхняя светлая кайма (`inset 0 1px 0 rgba(255,255,255,.02)`), глубокая тень.

### Логотип (`.brand`)

- Текст `ZALI` 20px, вес 900, `letter-spacing: .02em`
- Часть слова выделена в цвет `--lime` через `<em>` без курсива

### Hub Segment Nav (UI v2)

Переключатель режимов (Chats / Servers / ...):

```css
.hub-segment-nav {
    border: 1px solid rgba(255,255,255,.09);
    border-radius: 999px;
    background: linear-gradient(180deg, rgba(255,255,255,.065), rgba(255,255,255,.025)),
                rgba(0,0,0,.18);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.04), 0 10px 22px rgba(0,0,0,.16);
    min-height: 38px;
    padding: 4px;
}
```

**Активный индикатор** — плавающая капсула lime (`transition: .58s cubic-bezier(.22,.61,.36,1)`):
```css
.hub-segment-indicator {
    background:
        radial-gradient(circle at 28% 16%, rgba(255,255,255,.36), transparent 30%),
        linear-gradient(180deg, rgba(203,255,0,.98), rgba(203,255,0,.78));
    box-shadow: 0 10px 24px rgba(203,255,0,.24), inset 0 1px 0 rgba(255,255,255,.34);
    border-radius: 999px;
}
```

Кнопки сегмента — иконки 18×18px, stroke 1.9, uppercase label 10px, вес 950. Активная кнопка: цвет `#030402` (почти чёрный) на lime-фоне. При активации иконка получает `stroke-width: 2.25` и анимацию `segment-icon-pop`.

### Поиск (`.search-input`)

```css
height: 38px;
border: 1px solid var(--border);
border-radius: 10px;
background: linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.02));
box-shadow: inset 0 1px 0 rgba(255,255,255,.03), 0 8px 18px rgba(0,0,0,.08);
```

Focus:
```css
border-color: #cbff00;
box-shadow: 0 0 0 2px rgba(203,255,0,.10);
```

Иконка поиска: маска SVG, цвет `--text2`, position absolute слева.

### Список контактов / диалогов

- Отступы контейнера: `margin: 0 12px 12px`, `padding: 0 8px 10px`
- Каждый элемент — отдельный ряд с аватаром, именем, превью последнего сообщения, временем
- Активный элемент: мягкая подсветка lime-тоном

### Nav Labels

```css
.nav-label {
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
    color: var(--text3);  /* rgba(255,255,255,.25) */
    padding: 0 18px 8px;
}
```

---

## 8. Кнопки

### Primary (Lime)

Главное действие. Фон lime, текст чёрный.

```css
background: linear-gradient(180deg, rgba(203,255,0,.95), rgba(203,255,0,.75));
color: #050505;
box-shadow: 0 8px 18px rgba(203,255,0,.14), inset 0 1px 0 rgba(255,255,255,.20);
border: 1px solid var(--border);
border-radius: 10px;
```

Hover:
```css
filter: brightness(1.03);
box-shadow: 0 10px 22px rgba(203,255,0,.20), inset 0 1px 0 rgba(255,255,255,.22);
```

Active:
```css
transform: translateY(1px);
```

Disabled:
```css
opacity: .45;
cursor: not-allowed;
filter: grayscale(.20);
```

### Secondary (Glass)

Вспомогательные действия.

```css
border: 1px solid var(--border);
border-radius: 10–12px;
background: rgba(255,255,255,.03–.04);
color: var(--text2);
box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
transition: all .18s ease;
```

Hover:
```css
border-color: rgba(203,255,0,.28);
background: rgba(203,255,0,.08);
box-shadow: 0 0 0 2px var(--lime-dim);
color: var(--text);
```

### Mode-btn (Segment Toggle)

Используется в `mode-switch` — переключатель режимов чат/серверы (UI v1).

```css
height: 30px;
padding: 0 12px;
border-radius: 999px;
font-size: 11px;
font-weight: 900;
text-transform: uppercase;
letter-spacing: .08em;
```

Active:
```css
background: linear-gradient(180deg, rgba(203,255,0,.98), rgba(203,255,0,.82));
color: #050505;
box-shadow: 0 8px 18px rgba(203,255,0,.18);
```

### Destructive

```css
color: var(--red);  /* #ff4d6d */
/* фон secondary, но текст/акцент красный */
```

---

## 9. Поля ввода

Все инпуты:

```css
height: 38–40px;
border: 1px solid var(--border);
border-radius: 10px;
background: rgba(255,255,255,.03);
color: var(--text);
box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
transition: border-color .18s ease, box-shadow .18s ease, background .18s ease;
```

Focus (единый паттерн для всего приложения):
```css
border-color: #cbff00;
box-shadow: 0 0 0 2px rgba(203,255,0,.10);
```

Hover:
```css
background: rgba(255,255,255,.05);
```

Disabled:
```css
opacity: .55;
cursor: not-allowed;
```

Переменные высот:
```css
--control-h:    40px;   /* стандартный контрол */
--control-h-sm: 40px;   /* компактный */
```

---

## 10. Аватары

Буквенный аватар (когда нет фото):

```css
.contact-suggest-ava {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: #cbff00;
    color: #050505;
    font-size: 12px;
    font-weight: 900;
    display: grid;
    place-items: center;
}
```

Lime-фон, чёрная первая буква имени, round.

---

## 11. Карточки-предложения (Autocomplete / Suggest)

Дропдаун поиска пользователей:

```css
.contacts-suggest {
    border: 1px solid rgba(255,255,255,.18);
    border-radius: 12px;
    background: rgba(8,10,14,.98);
    box-shadow: 0 22px 48px rgba(0,0,0,.42);
    padding: 12px;
    gap: 8px;
    animation: suggest-drop .18s ease-out;
}
```

Элемент списка (`contact-suggest-item`):
```css
grid-template-columns: 34px 1fr auto;
gap: 10px;
padding: 12px;
border: 1px solid transparent;
border-radius: 10px;
background: rgba(255,255,255,.05);
transition: background .18s ease, border-color .18s ease;
```

Hover:
```css
background: rgba(255,255,255,.10);
border-color: rgba(203,255,0,.28);
```

Плюс-иконка добавления: цвет `#cbff00`, 20px, вес 900.

Пустое состояние:
```css
border: 1px dashed rgba(255,255,255,.16);
border-radius: 10px;
background: rgba(255,255,255,.03);
color: var(--text2);
font-size: 13px;
```

---

## 12. Мобильный Dock

Нижняя навигационная панель на мобильных:

```css
.mobile-dock {
    border: 1px solid var(--border);
    border-radius: 18px;
    background: rgba(8,10,14,.92);
    box-shadow: 0 18px 42px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.03);
    backdrop-filter: blur(16px);
    width: min(100vw - 20px, 440px);
    padding: 7px;
    gap: 8px;
}
```

Кнопки внутри dock:

```css
.mobile-dock-btn {
    min-height: 42px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: rgba(255,255,255,.03);
    color: var(--text2);
    font-size: 12px;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: .05em;
}
```

Активная / hover:
```css
border-color: rgba(203,255,0,.22);
color: var(--text);
background: rgba(203,255,0,.12);
box-shadow: 0 0 0 2px rgba(203,255,0,.10);
```

Backdrop кнопки мобильного меню:
```css
background: rgba(0,0,0,.55);
backdrop-filter: blur(2px);
```

---

## 13. Скроллбар

Кастомный скроллбар в стиле Zali:

```css
::-webkit-scrollbar { width: 10px; height: 10px; }

::-webkit-scrollbar-track {
    background: rgba(255,255,255,.03);
}

::-webkit-scrollbar-thumb {
    border: 2px solid rgba(0,0,0,.25);
    border-radius: 999px;
    background: linear-gradient(180deg, rgba(203,255,0,.82), rgba(203,255,0,.36));
}

/* Firefox */
scrollbar-color: rgba(203,255,0,.45) rgba(255,255,255,.04);
```

Lime-градиентный thumb, тёмный трек.

---

## 14. Glassmorphism — рецепт поверхности

Любая панель / карточка / модалка в стиле Zali строится по этому рецепту:

```css
background: rgba(255,255,255,.03);           /* почти прозрачный белый */
backdrop-filter: blur(16–40px);              /* размытие фона */
-webkit-backdrop-filter: blur(16–40px);
border: 1px solid rgba(255,255,255,.07–.09); /* тонкая рамка */
border-radius: 12–18px;                      /* умеренное скругление */
box-shadow:
    0 14–20px 36–50px rgba(0,0,0,.14–.60),  /* глубокая внешняя тень */
    inset 0 1px 0 rgba(255,255,255,.02–.04); /* тонкая светлая кайма сверху */
```

Параметры blur:
- Titlebar: `16px`
- Sidebar: `8px`
- Дропдауны / suggest: без blur (тёмный непрозрачный фон)
- Модалки / оверлеи: `16–40px`

---

## 15. Чат — область сообщений

### Пузыри сообщений

```css
--r-msg: 18px;  /* радиус пузырей */
--msg-gap: 2;   /* множитель зазора между сообщениями */
```

- Умеренное скругление `18px` — не «мессенджер-пузырь» 2010-х, не flat-прямоугольник
- Исходящие — lime-тон или более светлый glass
- Входящие — glass-тёмный
- Между сообщениями от одного автора: минимальный зазор
- Между блоками от разных авторов: бо́льший зазор

### Composer (поле ввода сообщения)

```css
--footer-dock-h:   68px;   /* высота нижней зоны */
--footer-dock-gap: 12px;   /* зазор внутри */
--footer-line-size: 1px;
--footer-line-color: var(--border);
--composer-inline-inset: 6px;
```

- Нижняя граница зоны ввода: `1px solid var(--border)`
- Поле ввода — glass-инпут с focus-highlight в lime
- Кнопка отправки — lime primary

---

## 16. Статусные индикаторы

### Online / Offline dot

```css
/* Online */
background: #cbff00;
box-shadow: 0 0 12px rgba(203,255,0,.25);

/* Offline */
background: #ff4d6d;
box-shadow: 0 0 12px rgba(255,77,109,.60);
```

Размер точки в ws-pill: `7×7px`, `border-radius: 50%`.

### Status pill (общий паттерн)

```css
height: 26px;
padding: 0 10px;
border: 1px solid var(--border);
border-radius: 999px;
font-size: 11px;
font-weight: 700;
background: rgba(255,255,255,.03);
```

---

## 17. Анимации и переходы

### Стандартный переход (почти все интерактивные элементы)

```css
transition: transform .18s ease,
            border-color .18s ease,
            background .18s ease,
            color .18s ease,
            box-shadow .18s ease;
```

### Segment indicator (плавающая капсула)

```css
transition: transform .58s cubic-bezier(.22, .61, .36, 1),
            width .28s ease,
            box-shadow .28s ease;
```

Упругий cubic-bezier — единственное место в UI с выраженным spring-движением.

### Icon pop (при активации сегмента)

```css
animation: segment-icon-pop .52s cubic-bezier(.20, 1.18, .20, 1) both;
```

Лёгкий pop-эффект иконки при переключении.

### Suggest dropdown

```css
animation: suggest-drop .18s ease-out;
```

Быстрое появление дропдауна сверху вниз.

### Active press

```css
transform: translateY(1px);  /* все кнопки при :active */
```

### Правила

- Transition не длиннее `0.6s` нигде, кроме segment indicator
- Hover-анимации: `0.18s ease` — быстро, не прыгает
- Нет bounce для сетевых / контентных событий
- Нет параллакса

---

## 18. Иконки

- SVG инлайн или CSS mask
- Размер: `18×18px` в навигации, `16×16px` в контексте текста, `20px` для акцентных (добавить, закрыть)
- Stroke: `1.9px` стандарт, `2.25px` активный
- `stroke-linecap: round`, `stroke-linejoin: round`
- Цвет наследуется через `currentColor`
- `pointer-events: none` — иконки не кликабельны сами по себе

---

## 19. Пустые состояния

Паттерн для любого пустого списка:

```css
border: 1px dashed rgba(255,255,255,.16);
border-radius: 10px;
background: rgba(255,255,255,.03);
color: var(--text2);
font-size: 13px;
line-height: 1.4;
padding: 12px 14px;
```

Пунктирная граница вместо solid — визуально «незаполненное место». Текст объясняет что делать дальше. Никогда молчащий экран.

---

## 20. Настройки

- Разбиты на компактные секции, каждая с коротким заголовком
- Секция — стеклянная карточка с `border-radius: 12–16px`
- Внутри секции: radio/segmented buttons для тем, toggle для бинарных настроек, slider для числовых, flat buttons для действий
- Ошибки и статусы — под контролом, мелким текстом, цвет `--red` или `--lime`
- Destructive actions — красным акцентом, отдельно от остальных кнопок

---

## 21. Тон текста в интерфейсе

| Хорошо | Плохо |
|---|---|
| «Сообщение отправлено» | «Ваше сообщение было успешно доставлено!» |
| «Контакт добавлен» | «Новый друг появился в вашем списке!» |
| «Подключение потеряно» | «Упс! Что-то пошло не так...» |
| «Не удалось загрузить» | «Произошла непредвиденная ошибка сети» |
| «Ключи подгрузятся из облака» | «Происходит синхронизация ваших данных безопасности» |

Короткий глагол, результат, без пафоса.

---

## 22. Быстрый чеклист «в стиле Zali»

- [ ] Фон тёмный и не плоский — есть lime-подсветки и сетка
- [ ] Lime используется только точечно
- [ ] Все карточки и панели — glassmorphism (border + blur + inset highlight)
- [ ] Скроллбар lime-градиент
- [ ] Focus-ring единый: lime border + lime-dim glow
- [ ] Primary button — lime с чёрным текстом
- [ ] Destructive — красным акцентом отдельно
- [ ] Анимации не длиннее 0.6s
- [ ] Пустые состояния объясняют следующий шаг
- [ ] Текст кратный: глагол + результат

---

## 23. В одной фразе

**Zali — dark glass, lime accents, compact utility, zero visual fluff.**
