#!/bin/bash
# Диагностика macOS и установленных Blender. Совместимо с системным Bash 3.2.
# Скрипт не устанавливает ПО, не открывает .blend и не меняет настройки.
# В Bash 3.2 nounset несовместим с обходом пустого массива кандидатов.
# Все используемые переменные инициализированы явно.
set -o pipefail

maccheck_source=""

maccheck_usage() {
    printf '%s\n' \
      'Проверка Mac и Blender без установки и изменения настроек.' \
      'Использование:' \
      '  bash tools/macos/mac_preflight.sh' \
      '  bash tools/macos/mac_preflight.sh --source "/полный/путь/temka.blend"' \
      '' \
      'Параметр --source только добавляет точную команду открытия в отчёт.' \
      'Сам файл этот скрипт не открывает.'
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        -h|--help)
            maccheck_usage
            exit 0
            ;;
        --source)
            if [ "$#" -lt 2 ] || [ -z "$2" ]; then
                printf '%s\n' 'Ошибка: после --source нужен путь к файлу.' >&2
                exit 2
            fi
            maccheck_source="$2"
            shift 2
            ;;
        *)
            printf 'Неизвестный параметр: %s\n' "$1" >&2
            maccheck_usage >&2
            exit 2
            ;;
    esac
done

maccheck_system="$(uname -s)"
if [ "$maccheck_system" != 'Darwin' ]; then
    printf 'Обнаружена система %s, а этот скрипт предназначен для macOS.\n' "$maccheck_system"
    printf '%s\n' \
      'Blender на Mac пользователя не проверен и не установлен.' \
      'Запустите этот же скрипт в Terminal на самом Mac или через локальный Codex.' \
      'Изменения в системе не выполнялись.'
    exit 2
fi

maccheck_machine="$(uname -m)"
maccheck_os="$(sw_vers -productVersion)"
maccheck_arm64="$(sysctl -n hw.optional.arm64 2>/dev/null || printf '0')"
maccheck_translated="$(sysctl -n sysctl.proc_translated 2>/dev/null || printf '0')"
maccheck_os_major="${maccheck_os%%.*}"
maccheck_os_tail="${maccheck_os#*.}"
maccheck_os_minor="${maccheck_os_tail%%.*}"
case "$maccheck_os_major:$maccheck_os_minor" in
    *[!0-9:]*|:*)
        printf 'Не удалось разобрать версию macOS: %s\n' "$maccheck_os" >&2
        exit 2
        ;;
esac

maccheck_is_arm=0
if [ "$maccheck_arm64" = '1' ] || [ "$maccheck_machine" = 'arm64' ] || [ "$maccheck_translated" = '1' ]; then
    maccheck_is_arm=1
fi

printf 'macOS: %s\n' "$maccheck_os"
printf 'Архитектура текущего процесса: %s\n' "$maccheck_machine"
if [ "$maccheck_is_arm" -eq 1 ]; then
    printf '%s\n' 'Процессор: Apple Silicon (ARM64).'
else
    printf '%s\n' 'Процессор: Intel / x86_64.'
fi
if [ "$maccheck_translated" = '1' ]; then
    printf '%s\n' 'Терминал работает через Rosetta. Для Blender выбирайте ARM64, а не x64.'
fi

maccheck_supported=1
maccheck_required_major=4
maccheck_required_minor=5
maccheck_required_patch=15
if [ "$maccheck_is_arm" -eq 1 ] && [ "$maccheck_os_major" -ge 13 ]; then
    maccheck_required_major=5
    maccheck_required_minor=2
    maccheck_required_patch=3
    printf '%s\n' \
      'Рекомендация для проекта: стабильная Blender 5.2 LTS для macOS ARM64.' \
      'Перед скачиванием проверьте актуальный стабильный выпуск на официальной странице.'
elif [ "$maccheck_os_major" -gt 11 ] || { [ "$maccheck_os_major" -eq 11 ] && [ "$maccheck_os_minor" -ge 2 ]; }; then
    if [ "$maccheck_is_arm" -eq 1 ]; then
        printf '%s\n' \
          'Рекомендация: Blender 4.5 LTS для macOS ARM64.' \
          'Blender 5.x требует macOS 13 или новее.'
    else
        printf '%s\n' \
          'Рекомендация: Blender 4.5 LTS для macOS x64 (Intel).' \
          'Это последняя официальная ветка Blender для Intel Mac.' \
          'Также нужна совместимая графика Metal 2.2; здесь графический запуск не проверяется.'
    fi
else
    maccheck_supported=0
    printf '%s\n' \
      'Эта macOS старее минимальной версии 11.2 для Blender 4.5 LTS.' \
      'Нужно отдельно подобрать совместимую версию и проверить открытие модели.' \
      'Установка современной ветки без дополнительной проверки не рекомендуется.'
fi
if [ "$maccheck_supported" -eq 1 ] && [ "$maccheck_required_major" -eq 4 ]; then
    printf '%s\n' \
      'Исходник temka.blend создан в Blender 5.2.3 и использует Geometry Nodes Array.' \
      'В Blender 4.5 новые функции могут потеряться; полный корректный экспорт не гарантирован.' \
      'Результат нужно сравнить с baseline room.glb и отчётом native_audit.'
fi
printf '%s\n' \
  'Загрузка: https://www.blender.org/download/' \
  'Ветка 4.5: https://download.blender.org/release/Blender4.5/' \
  'Требования: https://www.blender.org/download/requirements/'

maccheck_candidates=()
maccheck_add_candidate() {
    local maccheck_new="$1"
    local maccheck_old
    [ -f "$maccheck_new" ] && [ -x "$maccheck_new" ] || return 0
    for maccheck_old in "${maccheck_candidates[@]}"; do
        [ "$maccheck_old" != "$maccheck_new" ] || return 0
    done
    maccheck_candidates[${#maccheck_candidates[@]}]="$maccheck_new"
}

# Кавычки сохраняют пробелы в именах; проверка -x отбрасывает несовпавшие glob.
for maccheck_bundle in /Applications/Blender*.app; do
    maccheck_add_candidate "$maccheck_bundle/Contents/MacOS/Blender"
    maccheck_add_candidate "$maccheck_bundle/Contents/MacOS/blender"
done
if [ -n "${HOME:-}" ]; then
    for maccheck_bundle in "$HOME"/Applications/Blender*.app; do
        maccheck_add_candidate "$maccheck_bundle/Contents/MacOS/Blender"
        maccheck_add_candidate "$maccheck_bundle/Contents/MacOS/blender"
    done
fi
for maccheck_command in blender Blender; do
    maccheck_on_path="$(command -v "$maccheck_command" 2>/dev/null || true)"
    if [ -n "$maccheck_on_path" ]; then
        maccheck_add_candidate "$maccheck_on_path"
    fi
done

if [ "${#maccheck_candidates[@]}" -eq 0 ]; then
    printf '\n%s\n' \
      'Blender не найден в /Applications, ~/Applications и PATH.' \
      'Следующий шаг для Codex: скачать подходящий официальный DMG, проверить SHA256,' \
      'подключить его, скопировать Blender.app в свободный каталог Applications' \
      'и повторить эту проверку. Существующие установки не перезаписывать без необходимости.' \
      'Сам этот скрипт ничего не установил и не менял настройки macOS.'
    exit 3
fi

maccheck_selected=""
maccheck_best_major=0
maccheck_best_minor=0
maccheck_best_patch=0
for maccheck_binary in "${maccheck_candidates[@]}"; do
    printf '\nНайден: %s\n' "$maccheck_binary"
    if maccheck_version_output="$("$maccheck_binary" --version 2>&1)"; then
        printf '%s\n' "$maccheck_version_output" | awk '/^Blender [0-9]+\./ { print; exit }'
    else
        printf '%s\n' 'Проверка --version завершилась с ошибкой:'
        printf '%s\n' "$maccheck_version_output" | sed -n '1,5p'
        continue
    fi
    # Blender dependencies may write startup warnings before the version banner.
    # Inspect the actual Blender line; e.g. ARCH_CACHE_LINE_SIZE contains "RC".
    maccheck_version_line="$(printf '%s\n' "$maccheck_version_output" | awk '/^Blender [0-9]+\./ { print; exit }')"
    case "$maccheck_version_line" in
        *Alpha*|*Beta*|*alpha*|*beta*|*Candidate*|*candidate*|*RC*)
            printf '%s\n' 'Предварительная версия: для воспроизводимой обработки автоматически не выбирается.'
            continue
            ;;
    esac
    maccheck_version="$(printf '%s\n' "$maccheck_version_output" | awk '/^Blender [0-9]+\./ { print $2; exit }')"
    maccheck_major="${maccheck_version%%.*}"
    maccheck_rest="${maccheck_version#*.}"
    maccheck_minor="${maccheck_rest%%.*}"
    maccheck_patch="${maccheck_rest#*.}"
    maccheck_patch="${maccheck_patch%%[^0-9]*}"
    [ -n "$maccheck_patch" ] || maccheck_patch=0
    case "$maccheck_major:$maccheck_minor:$maccheck_patch" in
        *[!0-9:]*|:*|*::*|*:)
            printf '%s\n' 'Версию не удалось надёжно определить; автоматически её не выбираем.'
            continue
            ;;
    esac
    if [ "$maccheck_major" -lt 4 ] || { [ "$maccheck_major" -eq 4 ] && [ "$maccheck_minor" -lt 5 ]; }; then
        printf '%s\n' 'Эта версия старее минимальной ветки чтения современных .blend.'
        continue
    fi
    if [ "$maccheck_major" -ge 5 ] && { [ "$maccheck_is_arm" -ne 1 ] || [ "$maccheck_os_major" -lt 13 ]; }; then
        printf '%s\n' 'Blender 5.x не соответствует официальным требованиям для этого Mac.'
        continue
    fi
    if [ "$maccheck_supported" -ne 1 ]; then
        continue
    fi
    if [ "$maccheck_major" -ne "$maccheck_required_major" ] || [ "$maccheck_minor" -ne "$maccheck_required_minor" ]; then
        printf 'Для воспроизводимости выбран выпуск %s.%s.%s; эта другая ветка автоматически не выбирается.\n' \
          "$maccheck_required_major" "$maccheck_required_minor" "$maccheck_required_patch"
        printf '%s\n' 'Более новую стабильную ветку можно использовать после отдельной диагностики модели и сравнения с baseline.'
        continue
    fi
    if [ "$maccheck_patch" -lt "$maccheck_required_patch" ]; then
        printf 'Нужен patch не меньше %s в выбранной ветке; существующая установка не меняется.\n' "$maccheck_required_patch"
        continue
    fi
    if [ -z "$maccheck_selected" ] \
       || [ "$maccheck_major" -gt "$maccheck_best_major" ] \
       || { [ "$maccheck_major" -eq "$maccheck_best_major" ] && [ "$maccheck_minor" -gt "$maccheck_best_minor" ]; } \
       || { [ "$maccheck_major" -eq "$maccheck_best_major" ] && [ "$maccheck_minor" -eq "$maccheck_best_minor" ] && [ "$maccheck_patch" -gt "$maccheck_best_patch" ]; }; then
        maccheck_selected="$maccheck_binary"
        maccheck_best_major="$maccheck_major"
        maccheck_best_minor="$maccheck_minor"
        maccheck_best_patch="$maccheck_patch"
    fi
done

if [ -z "$maccheck_selected" ]; then
    printf '\n%s\n' \
      'Запускаемая стабильная версия выбранной ветки с требуемым patch не найдена.' \
      'Следующий шаг: диагностика найденной более новой ветки либо запуск tools/macos/install_blender_macos.sh.' \
      'Никакие приложения не установлены и настройки macOS не изменены.'
    exit 4
fi

printf '\nВыбрана для следующих команд: %s\n' "$maccheck_selected"
if [ -n "$maccheck_source" ]; then
    if [ ! -f "$maccheck_source" ]; then
        printf 'Указанный файл не найден: %s\n' "$maccheck_source" >&2
        exit 5
    fi
    maccheck_source_dir="$(cd "$(dirname "$maccheck_source")" && pwd -P)" || exit 5
    maccheck_source="$maccheck_source_dir/$(basename "$maccheck_source")"
    printf '%s\n' 'Команда открытия модели (напечатана, но не выполнена):'
    printf '  %q --factory-startup --disable-autoexec %q\n' "$maccheck_selected" "$maccheck_source"
else
    printf '%s\n' 'Команда запуска приложения (напечатана, но не выполнена):'
    printf '  %q --factory-startup --disable-autoexec\n' "$maccheck_selected"
    printf '%s\n' 'Добавьте --source "/полный/путь/temka.blend", чтобы получить команду открытия файла.'
fi
printf '%s\n' \
  'Успех --version подтверждает запуск бинарника; графика и сама модель ещё не проверены.' \
  'Скрипт не устанавливал ПО, не открывал модель и не менял пользовательские настройки.'
