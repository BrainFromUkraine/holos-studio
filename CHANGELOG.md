# Changelog

All notable changes to Holos Studio. Versions follow [Semantic Versioning](https://semver.org):
`0.2.0-beta.1`, `0.2.0-beta.2`, … are test builds of `0.2.0`; a version without a suffix is stable.

Every release has an English and a Ukrainian part. The release page on GitHub shows both; the update banner in the
app shows the part in the interface language. Sections: **New**, **Improved**, **Fixed**, **Removed**, **Known limitations**.

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
