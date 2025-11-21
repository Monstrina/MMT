document.addEventListener('DOMContentLoaded', () => {
    // --- Элементы ---
    const fileInput = document.getElementById('file-input');
    const dropZone = document.getElementById('drop-zone');
    const processArea = document.getElementById('process-area');
    const promptOutput = document.getElementById('prompt-output');
    const copyPromptBtn = document.getElementById('copy-prompt-btn');
    const translatedInput = document.getElementById('translated-input');
    const generateBtn = document.getElementById('generate-btn');
    const ruStatusMessage = document.getElementById('ru-status-message');
    
    // --- Элементы для "частей" (Chunking) ---
    const chunkControls = document.getElementById('chunk-controls');
    const prevChunkBtn = document.getElementById('prev-chunk-btn');
    const nextChunkBtn = document.getElementById('next-chunk-btn');
    const chunkStatus = document.getElementById('chunk-status');

    // --- Глобальные переменные состояния ---
    let modIdentifier = null; // Будет хранить ID мода (из jar) или имя файла (из json)
    let processingMode = 'jar'; // 'jar', 'json' или 'dual-json'
    let originalRuJsonString = null; // Для "доперевода"
    
    // --- Переменные для "частей" ---
    let promptChunks = [];
    let currentChunkIndex = 0;
    const MAX_KEYS_PER_CHUNK = 250;


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
    
    // ИЗМЕНЕНИЕ: Обработчик теперь вызывает handleInputFiles, передавая все выбранные файлы
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleInputFiles(e.target.files);
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
            handleInputFiles(files); // ИЗМЕНЕНИЕ: Вызываем handleInputFiles
        }
    });

    // --- Главный маршрутизатор обработки файлов ---
    function handleInputFiles(files) {
        // Сброс интерфейса
        resetUI();

        if (files.length === 1) {
            handleSingleFile(files[0]);
        } else if (files.length === 2) {
            handleDualJsonFiles(files); // НОВАЯ ФУНКЦИЯ
        } else {
            provideVisualFeedback(dropZone, false, 'Ошибка: Пожалуйста, выберите 1 файл (.jar/.json) или 2 файла (.json).');
        }
    }

    function resetUI() {
        ruStatusMessage.textContent = '';
        translatedInput.value = '';
        promptOutput.value = '';
        originalRuJsonString = null;
        modIdentifier = null;
        promptChunks = [];
        currentChunkIndex = 0;
        chunkControls.classList.add('hidden');
        processArea.classList.remove('show');
    }

    // --- НОВАЯ ФУНКЦИЯ: Обработка 2 файлов (Dual JSON) ---
    async function handleDualJsonFiles(files) {
        const file1 = files[0];
        const file2 = files[1];

        // Проверка расширений
        if (!file1.name.toLowerCase().endsWith('.json') || !file2.name.toLowerCase().endsWith('.json')) {
            provideVisualFeedback(dropZone, false, 'Ошибка: Для режима сравнения оба файла должны быть .json');
            return;
        }

        processingMode = 'dual-json';
        modIdentifier = 'custom_mod'; 

        try {
            const text1 = await file1.text();
            const text2 = await file2.text();

            let enContent, ruContent;

            // Определяем где какой язык по имени файла
            const name1 = file1.name.toLowerCase();
            const name2 = file2.name.toLowerCase();

            if (name1.includes('en_us') && name2.includes('ru_ru')) {
                enContent = text1;
                ruContent = text2;
            } else if (name2.includes('en_us') && name1.includes('ru_ru')) {
                enContent = text2;
                ruContent = text1;
            } else {
                throw new Error('Не удалось определить языки. Убедитесь, что файлы называются "en_us.json" и "ru_ru.json" (или содержат эти коды).');
            }

            // Очистка и парсинг
            const cleanEn = enContent.replace(/\u00A0/g, ' ');
            const cleanRu = ruContent.replace(/\u00A0/g, ' ');
            
            const enJson = JSON.parse(cleanEn);
            const ruJson = JSON.parse(cleanRu);

            originalRuJsonString = cleanRu; // Сохраняем оригинал для слияния в конце

            // Логика сравнения ключей (Delta)
            const missingKeysData = {};
            let missingCount = 0;

            for (const key in enJson) {
                if (enJson.hasOwnProperty(key) && !ruJson.hasOwnProperty(key)) {
                    missingKeysData[key] = enJson[key];
                    missingCount++;
                }
            }

            let promptPreamble;
            let jsonForPrompt;

            if (missingCount > 0) {
                ruStatusMessage.textContent = `Режим сравнения файлов: Обнаружено ${missingCount} недостающих ключей.`;
                jsonForPrompt = missingKeysData;
                promptPreamble = "Ваша задача — перевести *значения* **следующего JSON-объекта (только недостающие ключи)** для дополнения существующего перевода.";
            } else {
                ruStatusMessage.textContent = 'Режим сравнения файлов: Перевод актуален, все ключи из en_us есть в ru_ru.';
                jsonForPrompt = {};
                promptPreamble = "Перевод не требуется, все ключи совпадают.";
            }

            generatePromptAndChunks(jsonForPrompt, promptPreamble);

        } catch (error) {
            handleError(error);
        }
    }

    // --- Обработка 1 файла (JAR или JSON) ---
    async function handleSingleFile(file) {
        const fileName = file.name.toLowerCase();
        
        if (!fileName.endsWith('.jar') && !fileName.endsWith('.json')) {
            provideVisualFeedback(dropZone, false, 'Ошибка: Пожалуйста, выберите .jar или .json файл.');
            return;
        }

        try {
            let parsedEnJson;
            let promptPreamble;
            let jsonForPrompt = {};

            if (fileName.endsWith('.jar')) {
                // --- ЛОГИКА ДЛЯ .JAR ---
                processingMode = 'jar';
                const arrayBuffer = await file.arrayBuffer();
                const zip = new JSZip();
                await zip.loadAsync(arrayBuffer);

                let enUsJsonPath = null;
                let ruRuJsonPath = null;
                let modName = null;

                for (const [path, zipEntry] of Object.entries(zip.files)) {
                    if (path.startsWith('assets/') && path.split('/').length >= 4 && path.split('/')[2] === 'lang') {
                        const pathParts = path.split('/');
                        modName = pathParts[1];
                        if (path.endsWith('lang/en_us.json')) enUsJsonPath = path;
                        else if (path.endsWith('lang/ru_ru.json')) ruRuJsonPath = path;
                    }
                }

                if (!enUsJsonPath) {
                    throw new Error('Не удалось найти en_us.json в JAR-файле.');
                }

                modIdentifier = modName;
                const enUsJsonContent = await zip.file(enUsJsonPath).async('string');
                parsedEnJson = JSON.parse(enUsJsonContent);
                jsonForPrompt = parsedEnJson; 
                promptPreamble = "Ваша задача — перевести *значения* следующего JSON-объекта с английского на русский язык.";

                if (ruRuJsonPath) {
                    ruStatusMessage.textContent = 'Присутствует изначальный перевод мода.';
                    originalRuJsonString = await zip.file(ruRuJsonPath).async('string');
                    const parsedRuJson = JSON.parse(originalRuJsonString);
                    
                    const missingKeysData = {};
                    let missingCount = 0;
                    
                    for (const key in parsedEnJson) {
                        if (parsedEnJson.hasOwnProperty(key) && !parsedRuJson.hasOwnProperty(key)) {
                            missingKeysData[key] = parsedEnJson[key];
                            missingCount++;
                        }
                    }
                    
                    if (missingCount > 0) {
                        ruStatusMessage.textContent += ` (Обнаружено ${missingCount} недостающих ключей).`;
                        jsonForPrompt = missingKeysData;
                        promptPreamble = "Ваша задача — перевести *значения* **следующего JSON-объекта (только недостающие ключи)** для дополнения существующего перевода.";
                    } else {
                        ruStatusMessage.textContent += ' (Перевод актуален, все ключи совпадают).';
                        jsonForPrompt = {};
                        promptPreamble = "Перевод не требуется, все ключи совпадают.";
                    }
                } else {
                    ruStatusMessage.textContent = 'ru_ru.json не найден. Требуется полный перевод.';
                    originalRuJsonString = null;
                }
            
            } else {
                // --- ЛОГИКА ДЛЯ ОДИНОЧНОГО .JSON ---
                processingMode = 'json';
                modIdentifier = fileName.replace(/\.json$/i, '');
                
                let enUsJsonContent = await file.text();
                const cleanedJsonContent = enUsJsonContent.replace(/\u00A0/g, ' ');
                parsedEnJson = JSON.parse(cleanedJsonContent); 
                
                jsonForPrompt = parsedEnJson;
                promptPreamble = "Ваша задача — перевести *значения* следующего JSON-объекта с английского на русский язык.";
                ruStatusMessage.textContent = 'Загружен одиночный .json. Требуется полный перевод.';
                originalRuJsonString = null; 
            }

            generatePromptAndChunks(jsonForPrompt, promptPreamble);

        } catch (error) {
            handleError(error);
        }
    }

    // --- Вспомогательная функция: Генерация промпта и чанков ---
    function generatePromptAndChunks(jsonForPrompt, promptPreamble) {
        const allKeys = Object.keys(jsonForPrompt);
        promptChunks = []; 
        
        if (allKeys.length === 0) {
            promptOutput.value = promptPreamble;
            promptChunks = [promptPreamble];
            currentChunkIndex = 0;
            chunkControls.classList.add('hidden');
        
        } else if (allKeys.length > MAX_KEYS_PER_CHUNK) {
            const totalChunks = Math.ceil(allKeys.length / MAX_KEYS_PER_CHUNK);
            
            for (let i = 0; i < totalChunks; i++) {
                const chunkKeys = allKeys.slice(i * MAX_KEYS_PER_CHUNK, (i + 1) * MAX_KEYS_PER_CHUNK);
                const chunkJson = {};
                chunkKeys.forEach(key => {
                    chunkJson[key] = jsonForPrompt[key];
                });
                
                const prettifiedChunkJson = JSON.stringify(chunkJson, null, 2);
                const chunkPrompt = `${promptPreamble}
- **Это ЧАСТЬ ${i + 1} из ${totalChunks}**.
- **НЕ** переводите ключи JSON.
- **НЕ** изменяйте структуру JSON-объекта.
- **НЕ** изменяйте специальные коды форматирования, такие как "§d", "§5" и т.п. Это коды цвета и форматирования Minecraft, и они должны быть сохранены в точности.
- Ответьте **ТОЛЬКО** переведенным JSON-объектом, убедившись, что это единый, валидный блок кода JSON. Не включайте никаких пояснительных текстов до или после JSON.

Исходный английский JSON для перевода (Часть ${i + 1}/${totalChunks}):
${prettifiedChunkJson}`;
                promptChunks.push(chunkPrompt);
            }
            
            currentChunkIndex = 0;
            updateChunkView();
            chunkControls.classList.remove('hidden');
            
        } else {
            const prettifiedJson = JSON.stringify(jsonForPrompt, null, 2);
            const prompt = `${promptPreamble}
- **НЕ** переводите ключи JSON.
- **НЕ** изменяйте структуру JSON-объекта.
- **НЕ** изменяйте специальные коды форматирования, такие как "§d", "§5" и т.п. Это коды цвета и форматирования Minecraft, и они должны быть сохранены в точности.
- Ответьте **ТОЛЬКО** переведенным JSON-объектом, убедившись, что это единый, валидный блок кода JSON. Не включайте никаких пояснительных текстов до или после JSON.

Исходный английский JSON для перевода:
${prettifiedJson}`;
            
            promptOutput.value = prompt;
            promptChunks = [prompt];
            currentChunkIndex = 0;
            chunkControls.classList.add('hidden');
        }
        
        processArea.classList.add('show');
    }

    function handleError(error) {
        console.error('Error processing file:', error);
        let errorMessage = `Ошибка: ${error.message}`;
        if (error instanceof SyntaxError) {
            errorMessage = 'Ошибка: Загруженный файл содержит ошибку JSON. (Проверьте на www.jsonlint.com)';
        }
        ruStatusMessage.textContent = errorMessage;
        processArea.classList.add('show'); 
        provideVisualFeedback(dropZone, false, 'Ошибка при обработке файла'); 
    }
    
    // --- Функции для управления "частями" ---
    function updateChunkView() {
        if (promptChunks.length === 0) return;
        promptOutput.value = promptChunks[currentChunkIndex];
        chunkStatus.textContent = `Часть ${currentChunkIndex + 1}/${promptChunks.length}`;
        prevChunkBtn.disabled = (currentChunkIndex === 0);
        nextChunkBtn.disabled = (currentChunkIndex === promptChunks.length - 1);
    }
    
    prevChunkBtn.addEventListener('click', () => {
        if (currentChunkIndex > 0) {
            currentChunkIndex--;
            updateChunkView();
        }
    });
    
    nextChunkBtn.addEventListener('click', () => {
        if (currentChunkIndex < promptChunks.length - 1) {
            currentChunkIndex++;
            updateChunkView();
        }
    });

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
            let newTranslations;

            // --- Логика парсинга с учетом "частей" ---
            if (promptChunks.length > 1) {
                const jsonObjects = [];
                // Регулярное выражение для поиска JSON объектов, включая вложенные (простая рекурсия не поддерживается, но это пытается найти внешние фигурные скобки)
                const regex = /({(?:[^{}]|{(?:[^{}]|{[^{}]*})*})*})/g; 
                let match;
                
                while ((match = regex.exec(translatedJsonString)) !== null) {
                    try {
                        jsonObjects.push(JSON.parse(match[0]));
                    } catch (e) {
                        console.warn('Пропуск невалидного JSON-блока при сшивке:', match[0], e);
                    }
                }
                
                if (jsonObjects.length === 0) {
                    throw new SyntaxError("Не найдено валидных JSON-объектов. Убедитесь, что вы вставили все части.");
                }
                
                // Объединяем все переведенные части в один объект
                newTranslations = Object.assign({}, ...jsonObjects);

            } else {
                newTranslations = JSON.parse(translatedJsonString);
            }

            if (!modIdentifier) {
                provideVisualFeedback(generateBtn, false, 'Ошибка: Имя мода не найдено. Пожалуйста, перезагрузите и выберите файл снова.'); 
                return;
            }

            let finalJsonData;

            // --- ЛОГИКА ОБЪЕДИНЕНИЯ ---
            // Если был загружен ru_ru.json (в режиме JAR или Dual JSON), объединяем старые ключи с новыми переводами
            if (originalRuJsonString) {
                const originalRuData = JSON.parse(originalRuJsonString);
                // Object.assign: сохраняет оригинальные ключи, а новые (переведенные) перезаписывают старые, если они были в исходном запросе на перевод.
                finalJsonData = Object.assign(originalRuData, newTranslations);
            } else {
                // Если originalRuJsonString == null (полный перевод), используем только новые переводы
                finalJsonData = newTranslations;
            }

            const finalJsonString = JSON.stringify(finalJsonData, null, 2);
            const zip = new JSZip();
            const langCode = 'ru_ru';
            
            // --- Динамический путь в ZIP ---
            let internalPath;
            if (processingMode === 'json' || processingMode === 'dual-json') {
                // Для одиночного и двойного JSON сохраняем в корень ZIP (проще для ручной установки)
                internalPath = `${langCode}.json`; 
            } else {
                // Путь для .jar
                internalPath = `assets/${modIdentifier}/lang/${langCode}.json`; 
            }
            
            zip.file(internalPath, finalJsonString);
            
            const zipBlob = await zip.generateAsync({type: 'blob'});
            const url = URL.createObjectURL(zipBlob);
            
            const a = document.createElement('a');
            a.href = url;
            a.download = `${modIdentifier}_${langCode}_translation.zip`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            provideVisualFeedback(generateBtn, true, 'ZIP-файл перевода успешно загружен!');

        } catch (error) {
            if (error instanceof SyntaxError) {
                provideVisualFeedback(generateBtn, false, `Ошибка: Вставленное содержимое не является валидным JSON. ${error.message}`); 
            } else {
                console.error('Error generating ZIP:', error);
                provideVisualFeedback(generateBtn, false, `Ошибка: Произошла ошибка при создании ZIP-файла. ${error.message}`); 
            }
        }
    });
});
