# Changelog

All notable changes to Holos Studio. Versions follow [Semantic Versioning](https://semver.org):
`0.2.0-beta.1`, `0.2.0-beta.2`, … are test builds of `0.2.0`; a version without a suffix is stable.

Every release has an English and a Ukrainian part. The release page on GitHub shows both; the update banner in the
app shows the part in the interface language. Sections: **New**, **Improved**, **Fixed**, **Removed**, **Known limitations**.

## [0.2.0-beta.6] — 2026-10-17

Analyze and Auto-edit in the editor; the editor plays the finished sound.

### English

#### New

- **Analyze** (in the editor, next to "Done automatically"). Finds breaths, pauses, drop-outs, mouth clicks, repeats, retakes and fillers again with the current detectors — useful for a project made with an older version. Your hand edits stay; the new finds are not applied until Auto-edit. Ctrl+Z undoes it.
- **Auto-edit.** Applies the Automation settings to everything found and prepares the processed sound. Your hand edits stay. Ctrl+Z undoes it.
- **The editor plays the result.** "Result" plays every recording processed the way it will be exported — breaths, mouth clicks, voice processing, loudness — with the cuts and pauses applied on the fly, so a manual cut or restore is heard at once. "Original" plays the recordings as they are. After a change that alters the sound (a restored breath, an Automation setting), only the affected recording is prepared again, in the background; "Result …" means it is still being prepared.

### Українською

#### Нове

- **Аналіз** (у редакторі, поруч із «Зроблено автоматично»). Заново знаходить вдихи, паузи, провали фону, клацання, повтори, дублі й слова-паразити поточними детекторами — корисно для проєкту, зробленого старішою версією. Ваші ручні правки лишаються; нові знахідки не застосовуються до Автомонтажу. Ctrl+Z скасовує.
- **Автомонтаж.** Застосовує налаштування Автоматики до всього знайденого й готує оброблений звук. Ваші ручні правки лишаються. Ctrl+Z скасовує.
- **Редактор грає результат.** «Результат» грає кожен запис, оброблений так, як буде в експорті — вдихи, клацання, обробка голосу, гучність, — а вирізки й паузи накладаються на льоту, тож ручну вирізку чи відновлення чути одразу. «Оригінал» грає записи як є. Після зміни, що впливає на звук (відновлений вдих, налаштування Автоматики), у фоні заново готується лише потрібний запис; «Результат …» означає, що він ще готується.

## [0.2.0-beta.5] — 2026-10-17

Updates work while Claude Desktop is connected.

### English

#### Fixed

- **Engine updates no longer fail while Claude Desktop is open.** Claude Desktop keeps Holos's `holos.exe` running for the MCP connection, and Windows does not let an update replace (or even rename) that file, so preparing the new engine stopped with a misleading "check the internet connection" error. Claude Desktop now starts Holos as `python.exe -m holos mcp`, which an update never has to replace. Your existing Claude Desktop entry is moved to the new form automatically (only the Holos entry changes; a backup `claude_desktop_config.json.holos-backup` is kept). If an old connection still holds the file during this update, Holos stops it and carries on — restart Claude Desktop once afterwards.

### Українською

#### Виправлено

- **Оновлення рушія більше не падає, коли відкритий Claude Desktop.** Claude Desktop тримає запущеним `holos.exe` для MCP-з'єднання, а Windows не дає оновленню замінити (і навіть перейменувати) цей файл, тому підготовка нового рушія зупинялась з оманливою помилкою «перевірте з'єднання з інтернетом». Тепер Claude Desktop запускає Holos як `python.exe -m holos mcp`, і цей файл оновленню замінювати не треба. Наявний запис у Claude Desktop переводиться на новий вигляд автоматично (змінюється лише запис Holos; резервна копія — `claude_desktop_config.json.holos-backup`). Якщо під час цього оновлення старе з'єднання ще тримає файл, Holos його зупиняє і продовжує — після цього один раз перезапустіть Claude Desktop.

## [0.2.0-beta.4] — 2026-10-17

Breaths are found between phrases and really removed.

### English

#### Improved

- **Breaths are found much better.** Quick breaths between phrases (70–150 ms) were missed because the voice detector counted them as speech. Breaths are now told from the voice by the sound itself: quiet, well below the speech, and not tonal like a voice. Projects you already have are re-checked automatically the first time you open them; breath edits you changed by hand are kept.
- **"Remove" really removes breaths.** It used to lower them by 30 dB; now each breath is replaced with the room tone around it. The pause stays, so the rhythm of speech does not change. "Reduce" works as before.

#### Known limitations

- A voiced, gasping inhale that runs straight into a word is left as it is.

### Українською

#### Покращено

- **Вдихи знаходяться значно краще.** Швидкі вдихи між фразами (70–150 мс) пропускались, бо детектор голосу вважав їх мовою. Тепер вдих відрізняється від голосу за самим звуком: тихий, значно нижче мови і без тону, як у голосу. Наявні проєкти перевіряються заново автоматично під час першого відкриття; вдихи, які ви змінили вручну, лишаються.
- **«Прибрати» справді прибирає вдихи.** Раніше вони лише приглушувались на 30 dB; тепер кожен вдих замінюється фоном кімнати навколо нього. Пауза лишається, тож ритм мови не змінюється. «Приглушити» працює, як і раніше.

#### Відомі обмеження

- Дзвінкий, «схлипуючий» вдих, що переходить просто в слово, лишається як є.

## [0.2.0-beta.3] — 2026-10-17

Wet mouth clicks are removed properly.

### English

#### Improved

- **Mouth clicks.** Wet clicks (saliva, lips parting before a word) are now found and removed. They ring at 1–6 kHz for a few milliseconds, mostly below the band the old detector watched, so many were missed or only partly removed. Now such a click in a pause or right next to a word is replaced with the room sound around it: nothing is cut and the length does not change. A "т", "к" or "п" followed by a vowel is left alone. Short ticks inside speech are handled as before. The Automation strength (light / normal / strong) controls both.

### Українською

#### Покращено

- **Клацання слини.** Тепер програма знаходить і прибирає мокрі клацання (слина, губи розмикаються перед словом). Вони «дзвенять» на 1–6 кГц кілька мілісекунд, здебільшого нижче смуги, яку слухав старий детектор, тож багато з них пропускались або прибирались лише частково. Тепер таке клацання в паузі чи поруч зі словом замінюється фоном кімнати навколо нього: нічого не вирізається, довжина не змінюється. «Т», «к» чи «п» перед голосною не чіпаються. Короткі тіки всередині мови прибираються, як і раніше. Сила в Автоматиці (light / normal / strong) керує обома.

## [0.2.0-beta.2] — 2026-10-17

Recordings join back to back without extra silence; vertical zoom in the editor.

### English

#### New

- **Vertical zoom.** A second slider next to the time zoom makes the waveform up to 8× taller, so quiet mouth clicks and breaths are easy to see. Both sliders have icons and a tooltip; double-click the vertical one to reset it.

#### Fixed

- **Recordings are joined back to back.** There was always about 0.7 s of extra silence between two recordings, whatever the pause settings, and it could not be removed. Now the clips follow each other directly, and the pause at a join is as long as any other shortened pause (the pause target). The silence comes from the recordings themselves. Open projects are updated automatically.

### Українською

#### Нове

- **Вертикальний масштаб.** Другий слайдер поруч із масштабом часу робить хвилю до 8× вищою, тож тихі клацання слини й вдихи добре видно. Обидва слайдери мають іконки й підказку; подвійне натискання на вертикальний повертає його до початкового.

#### Виправлено

- **Записи склеюються встик.** Між двома записами завжди лишалося близько 0,7 с зайвої тиші, незалежно від налаштувань пауз, і прибрати її було не можна. Тепер кліпи йдуть один за одним, а пауза на стику така сама, як будь-яка скорочена пауза (цільова довжина паузи). Тиша береться із самих записів. Відкриті проєкти оновлюються автоматично.

## [0.2.0-beta.1] — 2026-10-11

First public beta.

### English

> Beta version: there may be bugs. Holos Studio never changes your original recordings.

#### New

- **Windows installer.** Install without terminals. The first launch downloads the components it needs (a few minutes, once).
- **Automatic updates.** The app offers a new version by itself and installs it in one click.
- **Projects.** A start screen with your episodes. Each project is its own folder with a copy of the recordings.
- **Automatic pass:**
  - files are joined in order;
  - pauses longer than X are shortened to Y;
  - mouth clicks are removed and breaths softened;
  - repeats and re-recorded takes are cut;
  - loudness is set to −16 LUFS.
- **Editor.** Splices, blade, range selection, chapter markers, spectrogram and loudness curve, Ctrl+Z for everything.
- **Automation.** Settings for a single project or as the default for new ones.
- **Export:**
  - WAV / MP3 with chapters;
  - timecodes for YouTube;
  - video through a template with a live preview.
- **Claude via MCP.** Timecodes and edits on request; step-by-step setup in Settings.
- **English and Ukrainian.** English by default; switch the language in Settings. Folder and file names are always English.

#### Known limitations

- Windows 10 / 11 only.
- The installer is not code-signed yet: Windows shows "Windows protected your PC" (More info → Run anyway).
- Without an NVIDIA GPU speech recognition is much slower.
- After the first launch the app takes about 5 GB of disk space (will be reduced).

### Українською

> Бета-версія: можливі помилки. Оригінальні записи програма ніколи не змінює.

#### Нове

- **Інсталятор для Windows.** Встановлення без терміналів. Перший запуск докачує потрібні компоненти (кілька хвилин, один раз).
- **Автоматичні оновлення.** Програма сама пропонує нову версію і встановлює її одним натисканням.
- **Проєкти.** Стартовий екран зі списком випусків. Кожен проєкт — окрема папка з копією записів.
- **Автоматична обробка:**
  - файли склеюються по порядку;
  - паузи довші за X скорочуються до Y;
  - клацання слини прибираються, вдихи приглушуються;
  - повтори й перезаписані дублі вирізаються;
  - гучність вирівнюється до −16 LUFS.
- **Редактор.** Склейки, лезо, виділення діапазону, маркери розділів, спектр і крива гучності, Ctrl+Z на все.
- **Автоматика.** Налаштування для окремого проєкту або за замовчуванням для нових.
- **Експорт:**
  - WAV / MP3 з розділами;
  - таймкоди для YouTube;
  - відео за шаблоном із живим прев'ю.
- **Claude через MCP.** Таймкоди і правки на прохання; покрокове підключення в Налаштуваннях.
- **Англійська та українська.** За замовчуванням англійська; мову можна змінити в Налаштуваннях. Назви папок і файлів завжди англійською.

#### Відомі обмеження

- Тільки Windows 10 / 11.
- Інсталятор поки без цифрового підпису: Windows покаже «Windows protected your PC» («Докладніше» → «Виконати все одно»).
- Без відеокарти NVIDIA розпізнавання мови значно повільніше.
- Після першого запуску програма займає близько 5 GB на диску (буде зменшено).
