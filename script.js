document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('file-input');
    const dropZone = document.getElementById('drop-zone');
    const processArea = document.getElementById('process-area');
    const promptOutput = document.getElementById('prompt-output');
    const copyPromptBtn = document.getElementById('copy-prompt-btn');
    const translatedInput = document.getElementById('translated-input');
    const generateBtn = document.getElementById('generate-btn');
    const ruStatusMessage = document.getElementById('ru-status-message');
    
    let modName = null;
    // --- НОВОЕ ---
    // Переменная для хранения оригинального ru_ru.json, если он будет найден
    let originalRuJsonString = null; 

    // --- Функция для визуальной обратной связи на кнопке ---
    function provideVisualFeedback(buttonElement, isSuccess = true, message = null) {
        buttonElement.classList.remove('btn-success', 'btn-error');
        const feedbackClass = isSuccess ? 'btn-success' : 'btn-error';
        buttonElement.classList.add(feedbackClass);
        if (message) {
            console.log(message);
        }
        setTimeout(() => {
            buttonElement.classList.remove(feedbackClass);
        }, 500); 
    }

    // --- File Selection and Processing ---
    dropZone.addEventListener('click', () => fileInput.click());
    
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFile(e.target.files[0]);
        }
    });

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, highlight, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, unhighlight, false);
    });

    function highlight(e) {
        dropZone.classList.add('dragover');
    }

    function unhighlight(e) {
        dropZone.classList.remove('dragover');
    }

    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files.length > 0) {
            handleFile(files[0]);
        }
    });

    async function handleFile(file) {
        // --- Сброс состояния при загрузке нового файла ---
        ruStatusMessage.textContent = '';
        translatedInput.value = '';
        promptOutput.value = '';
        originalRuJsonString = null; // Сбрасываем сохраненный ru_ru.json
        modName = null;

        if (!file.name.toLowerCase().endsWith('.jar')) {
            provideVisualFeedback(copyPromptBtn, false, 'Ошибка: Пожалуйста, выберите файл с расширением .jar.'); 
            return;
        }

        try {
            const arrayBuffer = await file.arrayBuffer();
            const zip = new JSZip();
            await zip.loadAsync(arrayBuffer);

            let enUsJsonPath = null;
            let ruRuJsonPath = null;
            
            // Ищем en_us.json и ru_ru.json
            for (const [path, zipEntry] of Object.entries(zip.files)) {
                if (path.startsWith('assets/') && path.split('/').length >= 4 && path.split('/')[2] === 'lang') {
                    const pathParts = path.split('/');
                    modName = pathParts[1]; // Извлекаем ID мода
                    
                    if (path.endsWith('lang/en_us.json')) {
                        enUsJsonPath = path;
                    } else if (path.endsWith('lang/ru_ru.json')) {
                        ruRuJsonPath = path;
                    }
                }
            }

            if (!enUsJsonPath) {
                provideVisualFeedback(copyPromptBtn, false, 'Ошибка: Не удалось найти en_us.json в JAR-файле.'); 
                return;
            }

            // 1. Получаем en_us.json (всегда нужен)
            const enUsJsonContent = await zip.file(enUsJsonPath).async('string');
            const parsedEnJson = JSON.parse(enUsJsonContent);
            
            let jsonForPrompt = parsedEnJson; // По умолчанию, JSON для промпта = полный en_us
            let promptPreamble = "Ваша задача — перевести *значения* следующего JSON-объекта с английского на русский язык.";

            // 2. Проверяем, найден ли ru_ru.json
            if (ruRuJsonPath) {
                ruStatusMessage.textContent = 'Присутствует изначальный перевод мода.';
                
                // Сохраняем оригинальный ru_ru.json в переменную
                originalRuJsonString = await zip.file(ruRuJsonPath).async('string');
                const parsedRuJson = JSON.parse(originalRuJsonString);
                
                // --- ЛОГИКА СРАВНЕНИЯ КЛЮЧЕЙ ---
                const missingKeysData = {};
                let missingCount = 0;
                
                // Ищем ключи из en_us, которых нет в ru_ru
                for (const key in parsedEnJson) {
                    if (parsedEnJson.hasOwnProperty(key) && !parsedRuJson.hasOwnProperty(key)) {
                        missingKeysData[key] = parsedEnJson[key];
                        missingCount++;
                    }
                }
                
                if (missingCount > 0) {
                    ruStatusMessage.textContent += ` (Обнаружено ${missingCount} недостающих ключей).`;
                    jsonForPrompt = missingKeysData; // В промпт пойдут ТОЛЬКО недостающие ключи
                    promptPreamble = "Ваша задача — перевести *значения* **следующего JSON-объекта (только недостающие ключи)** для дополнения существующего перевода.";
                } else {
                    ruStatusMessage.textContent += ' (Перевод актуален, все ключи совпадают).';
                    jsonForPrompt = {}; // Переводить нечего
                    promptPreamble = "Перевод не требуется, все ключи совпадают.";
                }
                
            } else {
                ruStatusMessage.textContent = 'ru_ru.json не найден. Требуется полный перевод.';
                originalRuJsonString = null; // Убедимся, что он пуст
            }

            // 3. Формируем промпт
            const prettifiedJson = JSON.stringify(jsonForPrompt, null, 2);
            const prompt = `${promptPreamble}
- **НЕ** переводите ключи JSON.
- **НЕ** изменяйте структуру JSON-объекта.
- **НЕ** изменяйте специальные коды форматирования, такие как "§d", "§5" и т.п. Это коды цвета и форматирования Minecraft, и они должны быть сохранены в точности.
- Ответьте **ТОЛЬКО** переведенным JSON-объектом, убедившись, что это единый, валидный блок кода JSON. Не включайте никаких пояснительных текстов до или после JSON.

Исходный английский JSON для перевода:
${prettifiedJson}`;
            
            promptOutput.value = prompt;
            
            processArea.classList.add('show');
            console.log(`Файл: ${enUsJsonPath}, Мод: ${modName}, ru_ru найден: ${!!ruRuJsonPath}`);

        } catch (error) {
            console.error('Error processing file:', error);
            provideVisualFeedback(copyPromptBtn, false, 'Ошибка: Произошла ошибка при обработке файла.'); 
            ruStatusMessage.textContent = '';
        }
    }

    // --- Clipboard ---
    copyPromptBtn.addEventListener('click', async () => {
        if (promptOutput.value) {
            try {
                await navigator.clipboard.writeText(promptOutput.value);
                provideVisualFeedback(copyPromptBtn, true, 'Промпт скопирован в буфер обмена!'); 
            } catch (err) {
                console.error('Failed to copy: ', err);
                promptOutput.select();
                provideVisualFeedback(copyPromptBtn, false, 'Промпт выделен. Нажмите Ctrl+C (Cmd+C), чтобы скопировать.'); 
            }
        } else {
             provideVisualFeedback(copyPromptBtn, false, 'Нечего копировать.'); 
        }
    });

    // --- ZIP Generation ---
    generateBtn.addEventListener('click', async () => {
        const translatedJsonString = translatedInput.value.trim();
        if (!translatedJsonString) {
            provideVisualFeedback(generateBtn, false, 'Ошибка: Пожалуйста, вставьте переведенный JSON.'); 
            return;
        }

        try {
            // 1. Парсим НОВЫЙ перевод (только недостающие ключи, или полный, если ru_ru не было)
            const newTranslations = JSON.parse(translatedJsonString);

            if (!modName) {
                provideVisualFeedback(generateBtn, false, 'Ошибка: Имя мода не найдено. Пожалуйста, перезагрузите и выберите файл снова.'); 
                return;
            }

            let finalJsonData;

            // --- ЛОГИКА ОБЪЕДИНЕНИЯ ---
            if (originalRuJsonString) {
                // Если у нас был оригинальный ru_ru.json...
                const originalRuData = JSON.parse(originalRuJsonString);
                // ...объединяем его с новыми переводами.
                // Новые ключи добавятся/перезапишутся.
                finalJsonData = Object.assign(originalRuData, newTranslations);
            } else {
                // Если оригинального ru_ru.json не было, то новый перевод - это и есть финальный файл.
                finalJsonData = newTranslations;
            }

            // 2. Превращаем финальный JSON в строку
            const finalJsonString = JSON.stringify(finalJsonData, null, 2);

            // 3. Создаем ZIP
            const zip = new JSZip();
            const langCode = 'ru_ru';
            const internalPath = `assets/${modName}/lang/${langCode}.json`;
            
            zip.file(internalPath, finalJsonString);
            
            const zipBlob = await zip.generateAsync({type: 'blob'});
            const url = URL.createObjectURL(zipBlob);
            
            const a = document.createElement('a');
            a.href = url;
            a.download = `${modName}_${langCode}_translation.zip`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            provideVisualFeedback(generateBtn, true, 'ZIP-файл перевода успешно загружен!');

        } catch (error) {
            if (error instanceof SyntaxError) {
                provideVisualFeedback(generateBtn, false, 'Ошибка: Вставленное содержимое не является валидным JSON.'); 
            } else {
                console.error('Error generating ZIP:', error);
                provideVisualFeedback(generateBtn, false, 'Ошибка: Произошла ошибка при создании ZIP-файла.'); 
            }
        }
    });
});