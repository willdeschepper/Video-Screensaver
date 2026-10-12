# Preencher tela + fundo configurável no Video Screensaver

## Context
Monitor ultrawide: hoje o mpv roda em modo "ajustar" e deixa barras pretas nas laterais. Pedido:
1. Opção para o vídeo **preencher a tela** → escolhido: **cortar (zoom)**, mantendo proporção.
2. Quando não preenche, escolher o **fundo das barras**: cor fixa (ex.: branco para vídeo de fundo branco) **ou** fundo "igual ao vídeo" → ambos os modos automáticos: **estender bordas** e **desfocado**.

Ambiente verificado: mpv 0.41, FFmpeg 8, GNOME 50. O mpv 0.41 já tem nativamente `--panscan`, `--border-background=<color|blur>`, `--background-color` e `--background-blur-radius` (só com vo=gpu-next, que é o padrão). "Estender bordas" não existe nativo → precisa de um script Lua pequeno usando o filtro `fillborders=mode=smear` do FFmpeg.

## Fluxo (SDD)
- Branch `feat/fill-and-background` (não mexer em main).
- T-00: gravar este plano como `specs/001-fill-and-background/spec.md` (com ACs abaixo) → commit.
- Depois, 1 tarefa = 1 commit citando IDs.

## Critérios de aceite
- AC-01 `fill-screen=true` → vídeo cobre o monitor todo sem barras, sem distorcer (corta excesso). mpv `--panscan=1.0`.
- AC-02 `background-mode=color` → barras na cor `background-color` (padrão `#000000` = comportamento atual, nenhum argumento extra enviado).
- AC-03 `background-mode=blur` → barras com o próprio vídeo desfocado (`--border-background=blur`).
- AC-04 `background-mode=edge` → barras preenchidas repetindo os pixels da borda do vídeo; vídeo de fundo branco fica contínuo.
- AC-05 Prefs: switch "Preencher tela", combo "Fundo", seletor de cor (visível só no modo Cor); controles de fundo ficam desabilitados quando "Preencher tela" está ligado.

## Tarefas

**T-00b Corrigir instalação (bloqueador, pré-requisito para testar)** — `install.sh`
- `SOURCE_SCHEMA` aponta para `...video-screensaver.gschema.xml`, mas o arquivo no repo é `...movie-screensaver.gschema.xml` → o script aborta com "Missing schema file". Corrigir o caminho (sem renomear o arquivo).
- Passo 3 das instruções finais usa a chave `video-path`, que não existe → trocar por `videos-folder`.

**T-01 Schema** — `schemas/org.gnome.shell.extensions.movie-screensaver.gschema.xml`
- `fill-screen` (b, false)
- `background-mode` (s, `'color'`, `<choices>` color/edge/blur)
- `background-color` (s, `'#000000'`)

**T-02 Args do mpv** — `extension.js` em `_launchMpv()` (linha ~518)
- Novo helper `_displayArgs(monitor)` retornando a lista extra de argumentos:
  - fill → `['--panscan=1.0']` (ignora fundo)
  - color → se cor ≠ `#000000`: `['--border-background=color', '--background-color=<hex>']`
  - blur → `['--border-background=blur']`
  - edge → `['--hwdec=auto-copy', '--script=<extDir>/edge-fill.lua', '--script-opts=edge_fill-aspect=<w/h do monitor>']` (`this.path` para o diretório; aspecto de `Main.layoutManager.monitors[screenIdx]`). `auto-copy` porque filtros de software não funcionam com hwdec direto; vem depois de `--hwdec=auto` no argv para sobrescrever.
- Espalhar `...this._displayArgs(...)` antes do `'--'`.

**T-03 Script `edge-fill.lua`** (novo, raiz da extensão)
- Lê `aspect` de `mp.options`; observa `video-params`; com `w,h` calcula tamanho alvo com a proporção da tela (pares), aplica `vf=lavfi=[pad=W:H:X:Y,fillborders=left=..:right=..:top=..:bottom=..:mode=smear]`; se já tem a proporção, limpa o `vf`. Guarda o último valor para não reaplicar em loop. ~30 linhas.

**T-04 Prefs** — `prefs.js`, grupo Video (após Shuffle, ~linha 160)
- `Adw.SwitchRow` "Fill screen" (subtitle: crop to cover ultrawide) com `settings.bind`.
- `Adw.ComboRow` "Background" com `Gtk.StringList` [Solid color, Extend video edges, Blurred video] ↔ `background-mode` (sync manual por índice, mesmo padrão de `connect('changed::...')` já usado para `videos-folder`).
- `Adw.ActionRow` "Background color" com `Gtk.ColorDialogButton` (GTK ≥4.10, ok no GNOME 47+); `rgba` ↔ string hex. Visível só se modo = color.
- `settings.bind('fill-screen', comboRow/colorRow, 'sensitive', INVERT_BOOLEAN)`.

**T-05 Instalação/README** — `install.sh` `SOURCE_FILES` += `edge-fill.lua`; README: descrever as opções e que exigem mpv ≥ 0.38 (`--border-background` / blur só gpu-next).

## Verificação
- Não existe `Makefile`/`make verify` no repo → rodar no lugar: `glib-compile-schemas --strict --dry-run schemas/`, `node --check extension.js prefs.js`, `luac -p edge-fill.lua` (ou `mpv` carregando o script). Registrar como Achado a falta do `make verify`.
- Teste isolado do mpv (sem instalar): gerar clipe 16:9 de fundo branco com `ffmpeg -f lavfi` no scratchpad e rodar `mpv --fs` com cada conjunto de args (panscan / color #ffffff / blur / edge) e conferir visualmente no ultrawide.
- Teste real: `./install.sh`, reiniciar sessão (Wayland), abrir prefs, alternar cada opção e usar "Start Screensaver Now".

## Achados (fora do escopo)
- Não há `make verify`; `movie_screensaver.zip` versionado no repo.
- `install.sh --system` copia o schema só para a pasta da extensão mas compila `/usr/share/glib-2.0/schemas` → a pasta da extensão fica sem `gschemas.compiled`.
- Screensaver pode disparar com a tela bloqueada (sem checar `Main.sessionMode.isLocked`) → mpv toca escondido, com áudio.
- O idle monitor ignora inibidores (ex.: assistindo vídeo no navegador sem mexer no mouse) → o screensaver entra por cima.
- `_killOrphanedPlayer` só mata o mpv do monitor 0 e confia num PID salvo (risco de reuso de PID).
- Wayland: `--screen/--fs-screen` são ignorados; com 2 monitores, os dois mpv podem cair na mesma tela.
- `Gtk.show_uri` está depreciado no GTK 4.10+ (ainda funciona).
