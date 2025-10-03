// ==UserScript==
// @name         智能抓包分析器 V31.1 (Aeterna Edition - Patched)
// @namespace    http://tampermonkey.net/
// @version      31.1
// @description  永恒版！100%完整代码，修复所有因代码省略导致的BUG。重构悬浮球交互，实现拖拽与点击分离、位置记忆。新增呼吸辉光与边界检测。集所有王牌功能于一身，此为完整、稳定、体验卓越的最终基石。
// @author       AI Assistant & You
// @match        *://*/*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    // =================================================================================
    // Main Sniffer Object - Encapsulates all modules to prevent scope issues
    // =================================================================================
    const SnifferV31 = {
        // =================================================================================
        // Part 1: 核心配置 (Config)
        // =================================================================================
        CONFIG: {
            MAX_REQUESTS_LIMIT: 1000,
            DEBOUNCE_DELAY: 100,
            PANEL_WIDTH: '500px',
            PANEL_HEIGHT: '60vh',
            PANEL_COLLAPSED_SIZE: '50px',
        },

        // =================================================================================
        // Part 2: 全局状态管理 (State)
        // =================================================================================
        state: {
            capturedRequests: [],
            isCapturing: true,
            hookSuccess: false,
            currentSortOrder: 'time',
            currentFilterType: 'all',
            currentSearchTerm: '',
            isPanelCollapsed: false,
            panelPosition: null, // { left: '20px', top: '20px' }
            updateSnifferUI: () => {},
        },

        // =================================================================================
        // Part 3: 实用工具 (Utils)
        // =================================================================================
        Utils: {
            resolveToFullUrl: (url) => { try { return new URL(url, window.location.href).href; } catch(e) { return url; } },
            formatBytes: (bytes, decimals = 2) => {
                if (!bytes || bytes === 0) return '0 B'; const k = 1024; const dm = decimals < 0 ? 0 : decimals;
                const sizes = ['B', 'KB', 'MB', 'GB']; const i = Math.floor(Math.log(bytes) / Math.log(k));
                return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
            },
            formatNumber: (num) => new Intl.NumberFormat('zh-CN').format(num),
            createToast: (message, type = 'info') => {
                let toastContainer = document.querySelector('.fx-toast-container');
                if (!toastContainer) {
                    toastContainer = document.createElement('div');
                    toastContainer.className = 'fx-toast-container';
                    document.body.appendChild(toastContainer);
                }
                const toastMessage = document.createElement('div');
                toastMessage.className = `fx-toast-message fx-toast-${type}`;
                toastMessage.textContent = message;
                toastContainer.appendChild(toastMessage);
                setTimeout(() => {
                    toastMessage.style.opacity = '0';
                    toastMessage.style.transform = 'translateY(-20px)';
                    setTimeout(() => toastMessage.remove(), 300);
                }, 3000);
            },
            escapeHtml: (str) => (str || '').toString().replace(/</g, "&lt;").replace(/>/g, "&gt;"),
            renderJsonAsTree: (json) => {
                if (typeof json !== 'object' || json === null) {
                    return `<span class="json-literal">${SnifferV31.Utils.escapeHtml(JSON.stringify(json))}</span>`;
                }
                const isArray = Array.isArray(json);
                let html = isArray ? '[<br>' : '{<br>';
                const keys = Object.keys(json);
                html += `<div class="json-branch">`;
                html += keys.map(key => {
                    const value = json[key];
                    const keyHtml = isArray ? '' : `<span class="json-key">"${key}"</span>: `;
                    return `<div class="json-node">${keyHtml}${SnifferV31.Utils.renderJsonAsTree(value)}</div>`;
                }).join('');
                html += `</div>`;
                html += isArray ? ']' : '}';
                return `<div class="json-collapsible">${html}</div>`;
            },
            parseInitiator: (stack) => {
                if (!stack) return 'N/A';
                return stack.split('\n')
                    .slice(1)
                    .map(line => line.trim())
                    .filter(line => !line.includes('userscript.html?name=') && !line.includes('<anonymous>'))
                    .map(line => {
                        return line.replace(/(at\s)(.*)(\s\()?(http.*:\d+:\d+)(\))?/, '$1<span class="initiator-func">$2</span>$3<a href="$4" class="initiator-link" target="_blank">$4</a>$5');
                    })
                    .join('\n');
            }
        },

        // =================================================================================
        // Part 4: 流式数据解析器 (Stream Parser)
        // =================================================================================
        StreamParser: {
            parse(line) {
                if (!line.startsWith('data:')) return null;
                const data = line.substring(5).trim();
                if (data === '<end>') return { type: 'end', raw: data };
                try {
                    const decoded = atob(data);
                    const cleaned = decoded.replace(/^<deep_x1>/, '');
                    try {
                        const json = JSON.parse(cleaned);
                        const content = json?.data?.content ?? '';
                        return { type: 'data', content: content, decoded: json, raw: data };
                    } catch (e) {
                        return { type: 'data', content: decoded, decoded: decoded, raw: data };
                    }
                } catch (e) {
                    return { type: 'raw', content: data, raw: data };
                }
            }
        },

        // =================================================================================
        // Part 5: 拦截器核心 (Interceptor Core)
        // =================================================================================
        Core: {
            init() {
                if (window.interceptorInjected) return;
                window.interceptorInjected = true;

                const debouncedUpdateUI = (() => {
                    let timeout;
                    return () => {
                        clearTimeout(timeout);
                        timeout = setTimeout(() => SnifferV31.state.updateSnifferUI(), SnifferV31.CONFIG.DEBOUNCE_DELAY);
                    };
                })();

                function processRequest(data) {
                    if (!SnifferV31.state.isCapturing) return;
                    if (SnifferV31.state.capturedRequests.length >= SnifferV31.CONFIG.MAX_REQUESTS_LIMIT) {
                        SnifferV31.state.capturedRequests.shift();
                    }
                    SnifferV31.state.capturedRequests.push(data);
                    debouncedUpdateUI();
                }

                function parseXhrHeaders(headerStr) {
                    if (!headerStr) return {};
                    return headerStr.split('\u000d\u000a')
                        .reduce((acc, headerPair) => {
                            if (headerPair.includes(': ')) {
                                const [key, value] = headerPair.split(': ', 2);
                                acc[key.toLowerCase()] = value;
                            }
                            return acc;
                        }, {});
                }

                const originalFetch = window.fetch;
                window.fetch = async function(...args) {
                    const initiator = new Error().stack;
                    if (!SnifferV31.state.isCapturing) return originalFetch.apply(this, args);

                    const request = new Request(...args);
                    const requestBody = await request.clone().text().catch(() => null);
                    const requestData = {
                        id: `req_${Date.now()}_${Math.random()}`, type: 'HTTP', status: 'pending', url: request.url, method: request.method.toUpperCase(),
                        startTime: Date.now(), request: { headers: Object.fromEntries(request.headers.entries()), body: requestBody }, response: {},
                        messages: [], aggregatedContent: '', timings: { startTime: Date.now() }, initiator: initiator
                    };
                    requestData.request.headers['cookie'] = document.cookie;
                    processRequest(requestData);

                    const findRequest = () => SnifferV31.state.capturedRequests.find(r => r.id === requestData.id);

                    try {
                        const response = await originalFetch.apply(this, args);
                        const existingRequest = findRequest();
                        if (!existingRequest) return response;

                        existingRequest.timings.responseStart = Date.now();
                        const contentType = response.headers.get('content-type');

                        if (contentType && contentType.includes('text/event-stream')) {
                            existingRequest.type = 'SSE';
                            existingRequest.status = 'streaming';
                            existingRequest.response = { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()) };
                            existingRequest.messages.push({ type: 'system', content: '流已建立 (Fetch SSE)' });
                            debouncedUpdateUI();

                            const [streamForBrowser, streamForSniffer] = response.body.tee();
                            const reader = streamForSniffer.getReader();
                            const decoder = new TextDecoder();
                            let buffer = '';

                            const readStream = async () => {
                                while (true) {
                                    try {
                                        const { done, value } = await reader.read();
                                        if (done) {
                                            existingRequest.messages.push({ type: 'system', content: '流已结束' });
                                            existingRequest.status = 'complete';
                                            existingRequest.duration = Date.now() - existingRequest.startTime;
                                            existingRequest.timings.endTime = Date.now();
                                            debouncedUpdateUI();
                                            break;
                                        }
                                        buffer += decoder.decode(value, { stream: true });
                                        const lines = buffer.split('\n');
                                        buffer = lines.pop();
                                        lines.forEach(line => {
                                            if (line.trim()) {
                                                const parsedMessage = SnifferV31.StreamParser.parse(line);
                                                if (parsedMessage) {
                                                    existingRequest.messages.push(parsedMessage);
                                                    if (parsedMessage.type === 'data' && typeof parsedMessage.content === 'string') {
                                                        existingRequest.aggregatedContent += parsedMessage.content;
                                                    }
                                                    if (parsedMessage.type === 'end') {
                                                        existingRequest.status = 'complete';
                                                        existingRequest.duration = Date.now() - existingRequest.startTime;
                                                        existingRequest.timings.endTime = Date.now();
                                                    }
                                                }
                                            }
                                        });
                                        debouncedUpdateUI();
                                    } catch (error) {
                                        existingRequest.messages.push({ type: 'system', content: `流读取错误: ${error}` });
                                        existingRequest.status = 'error';
                                        existingRequest.duration = Date.now() - existingRequest.startTime;
                                        existingRequest.timings.endTime = Date.now();
                                        debouncedUpdateUI();
                                        break;
                                    }
                                }
                            };
                            readStream();
                            return new Response(streamForBrowser, { status: response.status, statusText: response.statusText, headers: response.headers });
                        } else {
                            const responseClone = response.clone();
                            const bodyText = await responseClone.text();
                            let bodyParsed = bodyText;
                            try { bodyParsed = JSON.parse(bodyText); } catch (e) {}
                            existingRequest.status = 'complete';
                            existingRequest.duration = Date.now() - existingRequest.startTime;
                            existingRequest.timings.endTime = Date.now();
                            existingRequest.size = new Blob([bodyText]).size;
                            existingRequest.response = { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()), body: bodyParsed };
                            debouncedUpdateUI();
                            return response;
                        }
                    } catch (error) {
                        const existingRequest = findRequest();
                        if (existingRequest) {
                            existingRequest.status = 'error';
                            existingRequest.duration = Date.now() - existingRequest.startTime;
                            existingRequest.timings.endTime = Date.now();
                            existingRequest.response.error = error.toString();
                            debouncedUpdateUI();
                        }
                        throw error;
                    }
                };

                const xhrProto = XMLHttpRequest.prototype;
                const originalXhrOpen = xhrProto.open;
                const originalXhrSend = xhrProto.send;
                const originalSetRequestHeader = xhrProto.setRequestHeader;

                xhrProto.open = function(...args) {
                    this._method = args[0]; this._url = args[1]; this._requestHeaders = {};
                    return originalXhrOpen.apply(this, args);
                };

                xhrProto.setRequestHeader = function(header, value) {
                    this._requestHeaders[header.toLowerCase()] = value;
                    return originalSetRequestHeader.apply(this, arguments);
                };

                xhrProto.send = function(body) {
                    const initiator = new Error().stack;
                    if (!SnifferV31.state.isCapturing) return originalXhrSend.apply(this, arguments);

                    const requestData = {
                        id: `req_${Date.now()}_${Math.random()}`, type: 'HTTP', status: 'pending', url: this._url, method: this._method.toUpperCase(),
                        startTime: Date.now(), request: { headers: this._requestHeaders, body: body || null }, response: {},
                        messages: [], aggregatedContent: '', timings: { startTime: Date.now() }, initiator: initiator
                    };
                    requestData.request.headers['cookie'] = document.cookie;
                    this._requestData = requestData;
                    processRequest(requestData);

                    let isSseStream = false;
                    let processedLength = 0;

                    this.addEventListener('readystatechange', () => {
                        if (!this._requestData) return;
                        if (this.readyState >= 2 && !this._requestData.timings.responseStart) {
                            this._requestData.timings.responseStart = Date.now();
                        }
                        if (this.readyState < 2) return;

                        if (!isSseStream) {
                            try {
                                const contentType = this.getResponseHeader('Content-Type');
                                if (contentType && contentType.includes('text/event-stream')) {
                                    isSseStream = true;
                                    this._requestData.type = 'SSE';
                                    this._requestData.status = 'streaming';
                                    this._requestData.response = { status: this.status, statusText: this.statusText, headers: parseXhrHeaders(this.getAllResponseHeaders()) };
                                    this._requestData.messages.push({ type: 'system', content: '流已建立 (XHR SSE)' });
                                    debouncedUpdateUI();
                                }
                            } catch (e) {}
                        }
                    });

                    this.addEventListener('progress', () => {
                        if (isSseStream && this._requestData) {
                            const newText = this.responseText.substring(processedLength);
                            processedLength = this.responseText.length;
                            if (newText) {
                                const lines = newText.split('\n');
                                lines.forEach(line => {
                                    if (line.trim()) {
                                        const parsedMessage = SnifferV31.StreamParser.parse(line);
                                        if (parsedMessage) {
                                            this._requestData.messages.push(parsedMessage);
                                            if (parsedMessage.type === 'data' && typeof parsedMessage.content === 'string') {
                                                this._requestData.aggregatedContent += parsedMessage.content;
                                            }
                                        }
                                    }
                                });
                                debouncedUpdateUI();
                            }
                        }
                    });

                    const onEnd = () => {
                        if (!this._requestData) return;
                        if (isSseStream) {
                            this._requestData.messages.push({ type: 'system', content: '流已结束' });
                        } else {
                            let bodyParsed = this.responseText;
                            try { bodyParsed = JSON.parse(this.responseText); } catch (e) {}
                            this._requestData.response = { status: this.status, statusText: this.statusText, headers: parseXhrHeaders(this.getAllResponseHeaders()), body: bodyParsed };
                            this._requestData.size = new Blob([this.responseText]).size;
                        }
                        this._requestData.status = 'complete';
                        this._requestData.duration = Date.now() - this._requestData.startTime;
                        this._requestData.timings.endTime = Date.now();
                        debouncedUpdateUI();
                    };

                    this.addEventListener('load', onEnd, { once: true });
                    this.addEventListener('error', () => {
                        if (this._requestData) {
                            this._requestData.status = 'error';
                            this._requestData.duration = Date.now() - this._requestData.startTime;
                            this._requestData.timings.endTime = Date.now();
                            this._requestData.response.error = 'XHR 请求发生网络错误';
                            if (isSseStream) this._requestData.messages.push({ type: 'system', content: '流因网络错误中断' });
                            debouncedUpdateUI();
                        }
                    }, { once: true });

                    return originalXhrSend.apply(this, arguments);
                };

                const originalWebSocket = window.WebSocket;
                window.WebSocket = function(url, protocols) {
                    const initiator = new Error().stack;
                    if (!SnifferV31.state.isCapturing) return new originalWebSocket(url, protocols);

                    const requestData = {
                        id: `req_${Date.now()}_${Math.random()}`, type: 'WSS', status: 'pending', url: url, method: 'WSS',
                        startTime: Date.now(), request: { headers: {'Cookie': document.cookie} }, response: {}, messages: [],
                        timings: { startTime: Date.now() }, initiator: initiator
                    };
                    processRequest(requestData);

                    const socket = new originalWebSocket(url, protocols);
                    const findRequest = () => SnifferV31.state.capturedRequests.find(r => r.id === requestData.id);

                    socket.addEventListener('open', () => {
                        const req = findRequest();
                        if (req) {
                            req.status = 'streaming';
                            req.timings.responseStart = Date.now();
                            req.messages.push({ type: 'system', content: 'WebSocket 连接已建立' });
                            debouncedUpdateUI();
                        }
                    });

                    socket.addEventListener('message', (event) => {
                        const req = findRequest();
                        if (req) {
                            req.messages.push({ type: 'received', content: event.data });
                            debouncedUpdateUI();
                        }
                    });

                    socket.addEventListener('error', () => {
                        const req = findRequest();
                        if (req) {
                            req.status = 'error';
                            req.duration = Date.now() - req.startTime;
                            req.timings.endTime = Date.now();
                            req.messages.push({ type: 'system', content: 'WebSocket 连接发生错误' });
                            debouncedUpdateUI();
                        }
                    });

                    socket.addEventListener('close', (event) => {
                        const req = findRequest();
                        if (req) {
                            req.status = 'complete';
                            req.duration = Date.now() - req.startTime;
                            req.timings.endTime = Date.now();
                            req.messages.push({ type: 'system', content: `WebSocket 连接已关闭 - Code: ${event.code}, Reason: ${event.reason || 'N/A'}` });
                            debouncedUpdateUI();
                        }
                    });

                    const originalSend = socket.send;
                    socket.send = function(data) {
                        const req = findRequest();
                        if (req) {
                            req.messages.push({ type: 'sent', content: data });
                            debouncedUpdateUI();
                        }
                        return originalSend.apply(this, arguments);
                    };

                    return socket;
                };

                SnifferV31.state.hookSuccess = true;
                console.log(`[Sniffer V31.1] Genesis Edition 抓包核心已注入。`);
            }
        },

        // =================================================================================
        // Part 6: UI 渲染与管理 (UI Manager)
        // =================================================================================
        UI: {
            DOM: {},
            init() {
                if (document.getElementById('fx-sniffer-container')) return;
                this.injectCSS();
                this.injectHTML();
                this.cacheDOM();
                SnifferV31.state.updateSnifferUI = () => this.update();
                this.addEventListeners();
                this.update();
                console.log('[Sniffer V31.1] Genesis Edition UI 已成功注入并同步。');
            },
            injectCSS() {
                GM_addStyle(`
                    :root {
                        --bg-color-darkest: #21252b; --bg-color-dark: #282c34; --bg-color-medium: #3c4049; --border-color: #444;
                        --text-color-primary: #abb2bf; --text-color-light: #fff; --font-family: 'Segoe UI', sans-serif;
                        --color-blue: #61afef; --color-green: #98c379; --color-red: #e06c75; --color-yellow: #e5c07b;
                        --color-purple: #c678dd; --color-orange: #d19a66;
                    }
                    #fx-sniffer-container { position: fixed; bottom: 20px; right: 20px; width: ${SnifferV31.CONFIG.PANEL_WIDTH}; height: ${SnifferV31.CONFIG.PANEL_HEIGHT}; max-height: 90vh; min-width: 350px; min-height: 200px; background-color: var(--bg-color-dark); color: var(--text-color-primary); border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.4); display: flex; flex-direction: column; font-family: var(--font-family); z-index: 2147483647; transition: opacity 0.3s ease, transform 0.3s ease, width 0.3s ease, height 0.3s ease; overflow: hidden; border: 1px solid var(--border-color); resize: none; }
                    #fx-sniffer-container.collapsed { width: ${SnifferV31.CONFIG.PANEL_COLLAPSED_SIZE}; height: ${SnifferV31.CONFIG.PANEL_COLLAPSED_SIZE}; min-width: 0; min-height: 0; cursor: pointer; animation: fx-breathing-glow 2s infinite ease-in-out; }
                    #fx-sniffer-container.collapsed #fx-sniffer-header { padding: 0; align-items: center; justify-content: center; height: 100%; }
                    #fx-sniffer-container.collapsed > *:not(#fx-sniffer-header) { display: none; }
                    #fx-sniffer-container.collapsed #fx-sniffer-controls, #fx-sniffer-container.collapsed h3, #fx-sniffer-container.collapsed #fx-resize-handle { display: none; }
                    #fx-sniffer-container.collapsed #fx-toggle-collapse { display: block !important; font-size: 24px; }
                    #fx-resize-handle { position: absolute; top: 0; left: 0; width: 10px; height: 10px; cursor: nwse-resize; z-index: 10; }
                    #fx-sniffer-header { background-color: var(--bg-color-medium); padding: 10px 15px; cursor: move; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; user-select: none; flex-shrink: 0; }
                    #fx-sniffer-header h3 { margin: 0; font-size: 16px; color: var(--text-color-light); }
                    #fx-sniffer-controls { display: flex; align-items: center; gap: 8px; }
                    .fx-sniffer-select, #fx-search-input { background-color: var(--bg-color-darkest); color: var(--text-color-primary); border: 1px solid var(--border-color); border-radius: 4px; font-size: 12px; padding: 3px 6px; }
                    #fx-search-input { width: 120px; transition: width 0.3s ease; }
                    #fx-search-input:focus { width: 150px; }
                    #fx-status-indicator { width: 12px; height: 12px; border-radius: 50%; transition: background-color 0.3s; }
                    #fx-status-indicator.ok { background-color: var(--color-green); box-shadow: 0 0 8px var(--color-green); }
                    #fx-status-indicator.error { background-color: var(--color-red); box-shadow: 0 0 8px var(--color-red); }
                    @keyframes fx-pulse-animation { 0% { box-shadow: 0 0 0 0 rgba(97, 175, 239, 0.7); } 70% { box-shadow: 0 0 0 8px rgba(97, 175, 239, 0); } 100% { box-shadow: 0 0 0 0 rgba(97, 175, 239, 0); } }
                    @keyframes fx-breathing-glow { 0%, 100% { box-shadow: 0 0 5px var(--color-blue); } 50% { box-shadow: 0 0 15px var(--color-blue); } }
                    #fx-sniffer-list { list-style: none; padding: 5px; margin: 0; overflow-y: auto; flex-grow: 1; }
                    #fx-sniffer-list li { padding: 8px 12px; border-bottom: 1px solid var(--bg-color-medium); display: flex; align-items: center; justify-content: space-between; font-size: 14px; border-left: 3px solid transparent; transition: background-color 0.2s, border-left-color 0.3s; }
                    #fx-sniffer-list li.streaming-active { border-left-color: var(--color-blue); animation: fx-pulse-animation 2s infinite; }
                    .fx-request-info { cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-grow: 1; }
                    .fx-request-info:hover { color: var(--color-blue); }
                    .fx-request-info .method { font-weight: bold; margin-right: 8px; display: inline-block; width: 45px; text-align: center; border-radius: 3px; padding: 1px 0; }
                    .method-GET { color: var(--color-blue); background-color: rgba(97, 175, 239, 0.1); }
                    .method-POST { color: var(--color-green); background-color: rgba(152, 195, 121, 0.1); }
                    .method-PUT { color: var(--color-yellow); background-color: rgba(229, 192, 123, 0.1); }
                    .method-DELETE { color: var(--color-red); background-color: rgba(224, 108, 117, 0.1); }
                    .method-WSS { color: var(--color-purple); background-color: rgba(198, 120, 221, 0.1); }
                    .method-SSE { color: var(--color-orange); background-color: rgba(209, 154, 102, 0.1); }
                    #fx-sniffer-footer { background-color: var(--bg-color-medium); border-top: 1px solid var(--border-color); display: flex; flex-direction: column; flex-shrink: 0; }
                    #fx-sniffer-stats { display: flex; justify-content: space-around; padding: 8px 10px; font-size: 12px; border-bottom: 1px solid var(--border-color); }
                    .fx-action-group { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 10px; }
                    .fx-sniffer-btn { background-color: var(--color-blue); color: white; border: none; padding: 8px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; transition: background-color 0.2s ease; width: 100%; }
                    .fx-sniffer-btn:hover { filter: brightness(1.1); }
                    .fx-sniffer-btn.danger { background-color: var(--color-red); } .fx-sniffer-btn.secondary { background-color: #4b5263; }
                    .fx-sniffer-btn.success { background-color: var(--color-green); } .fx-sniffer-btn.curation { background-color: var(--color-purple); }
                    .fx-modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.7); z-index: 2147483647; display: flex; justify-content: center; align-items: center; }
                    .fx-modal-content { background-color: var(--bg-color-darkest); border: 1px solid #5c6370; padding: 0; border-radius: 12px; width: 80vw; max-width: 1000px; max-height: 90vh; display: flex; flex-direction: column; box-shadow: 0 10px 40px rgba(0,0,0,0.5); }
                    .fx-modal-header { background-color: var(--bg-color-dark); color: var(--text-color-light); padding: 12px 20px; border-bottom: 1px solid #5c6370; font-size: 18px; font-weight: bold; display: flex; justify-content: space-between; align-items: center; }
                    .fx-modal-body { padding: 20px; overflow-y: auto; }
                    .inspection-section { border: 1px solid #4b5263; border-radius: 8px; margin-bottom: 15px; overflow: hidden; }
                    .inspection-section-header { display: flex; justify-content: space-between; align-items: center; background-color: var(--bg-color-medium); padding: 8px 15px; cursor: pointer; }
                    .inspection-section-header h4 { margin: 0; font-size: 16px; color: var(--color-yellow); }
                    .inspection-section-content { padding: 15px; max-height: 300px; overflow-y: auto; background-color: var(--bg-color-dark); display: block; transition: all 0.3s ease; }
                    .inspection-section-content.collapsed { padding-top: 0; padding-bottom: 0; max-height: 0; }
                    .inspection-section-content pre, .inspection-section-content textarea { white-space: pre-wrap; word-wrap: break-word; margin: 0; font-family: 'Courier New', monospace; font-size: 14px; color: var(--text-color-primary); width: 100%; background: none; border: none; resize: vertical; }
                    .json-collapsible { cursor: pointer; }
                    .json-collapsible .json-branch { display: block; margin-left: 2em; }
                    .json-collapsible.collapsed > .json-branch { display: none; }
                    .json-key { color: var(--color-purple); } .json-literal { color: var(--color-green); }
                    .fx-stream-message { border-bottom: 1px solid var(--bg-color-medium); padding: 8px 5px; font-size: 13px; font-family: 'Courier New', monospace; white-space: pre-wrap; word-break: break-all; }
                    .fx-stream-message.sent { color: var(--color-green); } .fx-stream-message.received { color: var(--color-blue); } .fx-stream-message.system { color: var(--color-yellow); font-style: italic; }
                    .fx-toast-container { position: fixed; top: 20px; right: 20px; z-index: 2147483647; display: flex; flex-direction: column; gap: 10px; }
                    .fx-toast-message { padding: 12px 20px; border-radius: 8px; color: white; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); transition: opacity 0.3s, transform 0.3s; }
                    .fx-toast-info { background-color: var(--color-blue); } .fx-toast-success { background-color: var(--color-green); } .fx-toast-error { background-color: var(--color-red); }
                    .initiator-link { color: var(--color-blue); text-decoration: none; } .initiator-link:hover { text-decoration: underline; } .initiator-func { color: var(--color-yellow); }
                    .cookie-table { width: 100%; border-collapse: collapse; margin-top: 10px; } .cookie-table th, .cookie-table td { border: 1px solid var(--border-color); padding: 6px 8px; text-align: left; font-size: 12px; } .cookie-table th { background-color: var(--bg-color-medium); }
                `);
            },
            injectHTML() {
                const containerHTML = `
                    <div id="fx-sniffer-container">
                        <div id="fx-resize-handle"></div>
                        <div id="fx-sniffer-header">
                            <h3>抓包分析器 v31.1</h3>
                            <div id="fx-sniffer-controls">
                                <div id="fx-status-indicator" title="挂钩状态"></div>
                                <input type="text" id="fx-search-input" class="fx-sniffer-select" placeholder="按URL搜索..." title="根据URL关键字进行实时搜索">
                                <select id="fx-filter-select" class="fx-sniffer-select" title="按请求类型筛选"><option value="all">所有类型</option></select>
                                <select id="fx-sort-select" class="fx-sniffer-select" title="排序方式"><option value="time">时间</option><option value="size">大小</option><option value="duration">耗时</option></select>
                            </div>
                            <button class="fx-control-btn" id="fx-toggle-collapse" title="收起/展开面板" style="background:none; border:none; color:white; font-size:20px; cursor:pointer;">－</button>
                        </div>
                        <ul id="fx-sniffer-list"></ul>
                        <div id="fx-sniffer-footer">
                            <div id="fx-sniffer-stats">
                                <div>数量: <span id="fx-stat-count">0</span></div>
                                <div>大小: <span id="fx-stat-size">0 B</span></div>
                                <div>字符: <span id="fx-stat-tokens">0</span></div>
                            </div>
                            <div class="fx-action-group">
                                <button class="fx-sniffer-btn success" id="fx-pause-btn" title="暂停或继续捕获新的网络请求">暂停抓包</button>
                                <button class="fx-sniffer-btn danger" id="fx-clear-btn" title="清空当前已捕获的所有请求">清空列表</button>
                            </div>
                            <div class="fx-action-group">
                                <button class="fx-sniffer-btn curation" id="fx-smart-filter-btn" title="根据内置规则，一键过滤常见的追踪、静态资源等请求">智能预设过滤</button>
                                <button class="fx-sniffer-btn secondary" id="fx-copy-summary-btn" title="以纯文本列表形式复制所有请求的摘要信息">复制摘要</button>
                            </div>
                            <div class="fx-action-group">
                                <button class="fx-sniffer-btn" id="fx-copy-archive-btn" title="复制所有请求的完整JSON信息到剪贴板">复制JSON档案</button>
                                <button class="fx-sniffer-btn secondary" id="fx-export-archive-btn" title="将所有请求的完整JSON信息导出为 .json 文件">导出JSON档案</button>
                            </div>
                        </div>
                    </div>`;
                document.body.insertAdjacentHTML('beforeend', containerHTML);
            },
            cacheDOM() {
                this.DOM = {
                    container: document.getElementById('fx-sniffer-container'),
                    header: document.getElementById('fx-sniffer-header'),
                    list: document.getElementById('fx-sniffer-list'),
                    clearBtn: document.getElementById('fx-clear-btn'),
                    pauseBtn: document.getElementById('fx-pause-btn'),
                    collapseBtn: document.getElementById('fx-toggle-collapse'),
                    statCount: document.getElementById('fx-stat-count'),
                    statSize: document.getElementById('fx-stat-size'),
                    statTokens: document.getElementById('fx-stat-tokens'),
                    smartFilterBtn: document.getElementById('fx-smart-filter-btn'),
                    copySummaryBtn: document.getElementById('fx-copy-summary-btn'),
                    sortSelect: document.getElementById('fx-sort-select'),
                    filterSelect: document.getElementById('fx-filter-select'),
                    statusIndicator: document.getElementById('fx-status-indicator'),
                    searchInput: document.getElementById('fx-search-input'),
                    copyArchiveBtn: document.getElementById('fx-copy-archive-btn'),
                    exportArchiveBtn: document.getElementById('fx-export-archive-btn'),
                    resizeHandle: document.getElementById('fx-resize-handle'),
                };
            },
            update() {
                this.DOM.statusIndicator.className = SnifferV31.state.hookSuccess ? 'ok' : 'error';

                const availableTypes = [...new Set(SnifferV31.state.capturedRequests.map(req => req.type))];
                const currentOptions = Array.from(this.DOM.filterSelect.options).map(opt => opt.value);
                availableTypes.forEach(type => { if (!currentOptions.includes(type)) { this.DOM.filterSelect.add(new Option(type, type)); } });
                for (let i = this.DOM.filterSelect.options.length - 1; i > 0; i--) {
                    const option = this.DOM.filterSelect.options[i];
                    if (option.value !== 'all' && !availableTypes.includes(option.value)) { this.DOM.filterSelect.remove(i); }
                }
                if (!availableTypes.includes(SnifferV31.state.currentFilterType)) { SnifferV31.state.currentFilterType = 'all'; }
                this.DOM.filterSelect.value = SnifferV31.state.currentFilterType;

                let processedRequests = [...SnifferV31.state.capturedRequests]
                    .filter(req => SnifferV31.state.currentFilterType === 'all' || req.type === SnifferV31.state.currentFilterType)
                    .filter(req => req.url.toLowerCase().includes(SnifferV31.state.currentSearchTerm));

                processedRequests.sort((a, b) => {
                    if (SnifferV31.state.currentSortOrder === 'size') return (b.size || 0) - (a.size || 0);
                    if (SnifferV31.state.currentSortOrder === 'duration') return (b.duration || 0) - (a.duration || 0);
                    return 0;
                });

                this.DOM.list.innerHTML = processedRequests.map(req => {
                    const method = req.type === 'HTTP' ? req.method : req.type;
                    const url = req.url || '';
                    const shortUrl = url.length > 50 ? url.split('?')[0] : url;
                    const streamingClass = req.status === 'streaming' ? 'streaming-active' : '';
                    return `<li data-id="${req.id}" class="${streamingClass}">
                        <div class="fx-request-info" title="${url}"><span class="method method-${method}">${method}</span><span>${shortUrl}</span></div>
                        <div class="fx-item-controls">
                            <button class="fx-item-btn" title="复制选项..." style="background:none;border:none;color:inherit;cursor:pointer;">📋</button>
                            <button class="fx-item-btn" title="删除此条" style="background:none;border:none;color:inherit;cursor:pointer;">🗑️</button>
                        </div>
                    </li>`;
                }).join('');

                const totalSize = processedRequests.reduce((acc, req) => acc + (req.size || 0), 0);
                const totalChars = processedRequests.reduce((acc, req) => acc + JSON.stringify(req).length, 0);
                this.DOM.statCount.textContent = `${processedRequests.length} / ${SnifferV31.state.capturedRequests.length}`;
                this.DOM.statSize.textContent = SnifferV31.Utils.formatBytes(totalSize);
                this.DOM.statTokens.textContent = SnifferV31.Utils.formatNumber(totalChars);
            },
            addEventListeners() {
                const DOM = this.DOM;
                let isDragging = false, isResizing = false;
                let dragStartX, dragStartY, hasDragged;

                // 新增：确保面板在视口内的函数
                const ensureInBounds = () => {
                    const rect = DOM.container.getBoundingClientRect();
                    const viewportWidth = window.innerWidth;
                    const viewportHeight = window.innerHeight;

                    let newLeft = rect.left;
                    let newTop = rect.top;

                    if (rect.right > viewportWidth) newLeft = viewportWidth - rect.width;
                    if (rect.bottom > viewportHeight) newTop = viewportHeight - rect.height;
                    if (rect.left < 0) newLeft = 0;
                    if (rect.top < 0) newTop = 0;

                    if (newLeft !== rect.left || newTop !== rect.top) {
                        DOM.container.style.left = `${newLeft}px`;
                        DOM.container.style.top = `${newTop}px`;
                        DOM.container.style.right = 'auto';
                        DOM.container.style.bottom = 'auto';
                    }
                };

                const onMouseDown = (e) => {
                    if (e.target === DOM.resizeHandle) {
                        isResizing = true;
                        document.body.style.userSelect = 'none';
                        e.stopPropagation();
                        return;
                    }
                    // 优化：仅当点击标题栏（而非控件）时才开始拖动
                    if (e.target.closest('#fx-sniffer-header') && !e.target.closest('#fx-sniffer-controls, .fx-control-btn')) {
                        isDragging = true;
                        hasDragged = false;
                        dragStartX = e.clientX;
                        dragStartY = e.clientY;
                        DOM.container.style.transition = 'none';
                    }
                };

                const onMouseMove = (e) => {
                    if (isDragging) {
                        const dx = e.clientX - dragStartX;
                        const dy = e.clientY - dragStartY;
                        if (!hasDragged && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
                            hasDragged = true;
                            // 首次拖动时，切换为 left/top 定位
                            DOM.container.style.right = 'auto';
                            DOM.container.style.bottom = 'auto';
                        }

                        let newLeft = DOM.container.offsetLeft + dx;
                        let newTop = DOM.container.offsetTop + dy;

                        // 拖动时进行边界检查
                        const containerWidth = DOM.container.offsetWidth;
                        const containerHeight = DOM.container.offsetHeight;
                        newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - containerWidth));
                        newTop = Math.max(0, Math.min(newTop, window.innerHeight - containerHeight));

                        DOM.container.style.left = `${newLeft}px`;
                        DOM.container.style.top = `${newTop}px`;
                        dragStartX = e.clientX;
                        dragStartY = e.clientY;
                    }
                    if (isResizing) {
                        // 修正并简化缩放逻辑
                        const rect = DOM.container.getBoundingClientRect();
                        const newLeft = e.clientX;
                        const newTop = e.clientY;
                        const newWidth = rect.right - newLeft;
                        const newHeight = rect.bottom - newTop;

                        const minWidth = 350;
                        const minHeight = 200;

                        if (newWidth > minWidth) {
                            DOM.container.style.left = `${newLeft}px`;
                            DOM.container.style.width = `${newWidth}px`;
                        }
                        if (newHeight > minHeight) {
                            DOM.container.style.top = `${newTop}px`;
                            DOM.container.style.height = `${newHeight}px`;
                        }
                    }
                };

                const onMouseUp = () => {
                    if (isDragging) {
                        // 如果是单击（未拖动）且面板已折叠，则展开
                        if (!hasDragged && SnifferV31.state.isPanelCollapsed) {
                            SnifferV31.state.isPanelCollapsed = false;
                            DOM.container.classList.remove('collapsed');
                            DOM.collapseBtn.textContent = '－';
                            if (SnifferV31.state.panelPosition) {
                                DOM.container.style.left = SnifferV31.state.panelPosition.left;
                                DOM.container.style.top = SnifferV31.state.panelPosition.top;
                            }
                            // 延迟检查边界，等待UI渲染
                            setTimeout(ensureInBounds, 50);
                        } else if (hasDragged) {
                            // 如果是拖动，则校正边界并保存位置
                            ensureInBounds();
                            SnifferV31.state.panelPosition = { left: DOM.container.style.left, top: DOM.container.style.top };
                        }
                        DOM.container.style.transition = 'opacity 0.3s ease, transform 0.3s ease, width 0.3s ease, height 0.3s ease';
                    }
                    if (isResizing) {
                        ensureInBounds();
                        SnifferV31.state.panelPosition = { left: DOM.container.style.left, top: DOM.container.style.top };
                    }

                    isDragging = false;
                    isResizing = false;
                    document.body.style.userSelect = '';
                };

                DOM.header.addEventListener('mousedown', onMouseDown);
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);

                DOM.collapseBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // 折叠前保存当前位置
                    if (!SnifferV31.state.isPanelCollapsed) {
                        const rect = DOM.container.getBoundingClientRect();
                        SnifferV31.state.panelPosition = { left: `${rect.left}px`, top: `${rect.top}px` };
                    }
                    SnifferV31.state.isPanelCollapsed = true;
                    DOM.container.classList.add('collapsed');
                    DOM.collapseBtn.textContent = '＋';
                });

                // 原有的 container click 监听器已被移除，逻辑合并到 onMouseUp 中

                DOM.clearBtn.addEventListener('click', () => { SnifferV31.state.capturedRequests = []; this.update(); SnifferV31.Utils.createToast('列表已清空', 'info'); });
                DOM.pauseBtn.addEventListener('click', () => {
                    SnifferV31.state.isCapturing = !SnifferV31.state.isCapturing;
                    DOM.pauseBtn.textContent = SnifferV31.state.isCapturing ? '暂停抓包' : '继续抓包';
                    DOM.pauseBtn.classList.toggle('success');
                    DOM.pauseBtn.classList.toggle('danger');
                    SnifferV31.Utils.createToast(SnifferV31.state.isCapturing ? '已恢复抓包' : '已暂停抓包', 'info');
                });
                DOM.smartFilterBtn.addEventListener('click', () => SnifferV31.applySmartFilter());
                DOM.copySummaryBtn.addEventListener('click', () => SnifferV31.copyRequestSummary());
                DOM.copyArchiveBtn.addEventListener('click', () => SnifferV31.handleFullDataAction('copy'));
                DOM.exportArchiveBtn.addEventListener('click', () => SnifferV31.handleFullDataAction('export'));

                DOM.sortSelect.addEventListener('change', (e) => { SnifferV31.state.currentSortOrder = e.target.value; this.update(); });
                DOM.filterSelect.addEventListener('change', (e) => { SnifferV31.state.currentFilterType = e.target.value; this.update(); });
                DOM.searchInput.addEventListener('input', (e) => { SnifferV31.state.currentSearchTerm = e.target.value.toLowerCase().trim(); this.update(); });

                DOM.list.addEventListener('click', (e) => {
                    const li = e.target.closest('li');
                    if (!li) return;
                    const reqId = li.dataset.id;
                    const request = SnifferV31.state.capturedRequests.find(r => r.id === reqId);
                    if (!request) return;

                    if (e.target.closest('.fx-item-btn[title*="复制"]')) { SnifferV31.showCopyOptionsModal(request); }
                    else if (e.target.closest('.fx-item-btn[title*="删除"]')) {
                        SnifferV31.state.capturedRequests = SnifferV31.state.capturedRequests.filter(r => r.id !== reqId);
                        this.update();
                    }
                    else if (e.target.closest('.fx-request-info')) { SnifferV31.showDeepInspectionModal(request); }
                });
            },
        },

        // =================================================================================
        // Part 7: 功能逻辑 (Features & Exporters)
        // =================================================================================
        applySmartFilter() {
            if (this.state.capturedRequests.length === 0) return this.Utils.createToast('列表为空，无需过滤', 'info');
            const originalCount = this.state.capturedRequests.length;
            const filterKeywords = [ 'o.clarity.ms', 'riskct.geetest.com', 'openres.xfyun.cn', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.css', '.js', '.woff', '.woff2', 'client_report' ];
            this.state.capturedRequests = this.state.capturedRequests.filter(req => !filterKeywords.some(keyword => this.Utils.resolveToFullUrl(req.url).includes(keyword)));
            const removedCount = originalCount - this.state.capturedRequests.length;
            this.Utils.createToast(`智能过滤完成，移除了 ${removedCount} 条请求。`, 'success');
            this.UI.update();
        },
        copyRequestSummary() {
            const requests = this.state.capturedRequests;
            if (requests.length === 0) return this.Utils.createToast('列表为空，无法复制摘要', 'error');
            const summaryList = requests.map(req => {
                const fullUrl = this.Utils.resolveToFullUrl(req.url);
                const urlObj = new URL(fullUrl);
                const name = urlObj.pathname.split('/').pop() || urlObj.hostname;
                return `${name.padEnd(40, ' ')}${(req.type === 'HTTP' ? req.method : req.type).padEnd(7, ' ')}${fullUrl}`;
            }).join('\n');
            GM_setClipboard(summaryList);
            this.Utils.createToast(`已成功复制 ${requests.length} 条请求的摘要！`, 'success');
        },
        handleFullDataAction(action) {
            const requestsToProcess = this.state.capturedRequests;
            if (requestsToProcess.length === 0) return this.Utils.createToast('没有可处理的数据！', 'error');

            try {
                const formattedOutput = JSON.stringify(requestsToProcess, null, 2);
                if (action === 'copy') {
                    GM_setClipboard(formattedOutput);
                    this.Utils.createToast(`已成功复制 ${requestsToProcess.length} 条请求的完整JSON档案！`, 'success');
                } else if (action === 'export') {
                    const blob = new Blob([formattedOutput], { type: 'application/json;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `network_capture_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    this.Utils.createToast('JSON档案已开始导出！', 'success');
                }
            } catch (e) {
                console.error('数据处理时发生错误:', e);
                this.Utils.createToast('处理数据时发生错误，请查看控制台。', 'error');
            }
        },
        showCopyOptionsModal(req) {
            const isStream = req.type === 'WSS' || req.type === 'SSE';
            const buttonsHtml = isStream ?
                `<button class="fx-sniffer-btn" data-copy-type="stream-url" title="仅复制此流连接的URL">复制连接 URL</button>
                 <button class="fx-sniffer-btn secondary" data-copy-type="stream-messages" title="以JSON格式复制所有消息记录">复制消息记录</button>` :
                `<button class="fx-sniffer-btn" data-copy-type="curl" title="生成cURL命令，用于在终端中复现请求">复制为 cURL</button>
                 <button class="fx-sniffer-btn secondary" data-copy-type="fetch" title="生成JavaScript Fetch代码片段">复制为 Fetch</button>
                 <button class="fx-sniffer-btn curation" data-copy-type="json" title="以JSON格式复制此条请求的全部捕获数据">复制为完整 JSON</button>`;

            const modal = this.createModal('复制选项', `<div class="fx-action-group" style="grid-template-columns: 1fr;">${buttonsHtml}</div>`);

            modal.addEventListener('click', (e) => {
                if (e.target.matches('[data-copy-type]')) {
                    const copyType = e.target.getAttribute('data-copy-type');
                    let content = '', message = '';
                    switch(copyType) {
                        case 'curl': content = this.generateCurlCommand(req); message = '已复制为 cURL 命令！'; break;
                        case 'fetch': content = this.generateFetchSnippet(req); message = '已复制为 Fetch 代码！'; break;
                        case 'json': content = JSON.stringify(req, null, 2); message = '已复制为完整 JSON！'; break;
                        case 'stream-url': content = req.url; message = `已复制 ${req.type} URL！`; break;
                        case 'stream-messages': content = JSON.stringify(req.messages, null, 2); message = '已复制消息记录为 JSON！'; break;
                    }
                    GM_setClipboard(content);
                    this.Utils.createToast(message, 'success');
                    modal.remove();
                }
            });
        },
        showDeepInspectionModal(req) {
            const createSection = (title, content, isJson = false, isCollapsible = true, isTextarea = false) => {
                let contentHtml;
                if (isTextarea) {
                    contentHtml = `<textarea readonly rows="8">${this.Utils.escapeHtml(content)}</textarea>`;
                } else {
                    contentHtml = isJson ? this.Utils.renderJsonAsTree(content) : `<pre>${this.Utils.escapeHtml(content)}</pre>`;
                }
                return `<div class="inspection-section">
                    <div class="inspection-section-header" ${isCollapsible ? 'title="点击折叠/展开此区域"' : ''}><h4>${title}</h4></div>
                    <div class="inspection-section-content">${contentHtml}</div>
                </div>`;
            };

            let modalBodyHtml = '';
            const { timings, duration } = req;
            const waiting = timings.responseStart ? timings.responseStart - timings.startTime : null;
            const downloading = timings.endTime && timings.responseStart ? timings.endTime - timings.responseStart : null;
            const timingContent = `请求排队: N/A (浏览器处理)\n等待响应 (TTFB): ${waiting !== null ? waiting + ' ms' : 'N/A'}\n内容下载: ${downloading !== null ? downloading + ' ms' : 'N/A'}\n\n总计: ${duration || 'N/A'} ms`;

            if (req.type === 'SSE' || req.type === 'WSS') {
                const messagesHtml = (req.messages || []).map(msg => {
                    const icon = msg.type === 'received' ? '🔽' : (msg.type === 'sent' ? '🔼' : '⚙️');
                    const content = typeof msg.decoded === 'object' ? JSON.stringify(msg.decoded, null, 2) : this.Utils.escapeHtml(msg.content || msg.raw);
                    return `<div class="fx-stream-message ${msg.type}">${icon} [${new Date(msg.timestamp || Date.now()).toLocaleTimeString()}] \n${content}</div>`;
                }).join('');

                modalBodyHtml = createSection('▼ 聚合内容', req.aggregatedContent || '流内容聚合中...', false, false, true) +
                                createSection('▼ 时序瀑布流', timingContent) +
                                createSection('▼ 调用堆栈 (Initiator)', this.Utils.parseInitiator(req.initiator), false, true) +
                                createSection('▼ 连接信息', `URL: ${req.url}\n状态: ${req.status}`) +
                                createSection('▼ 原始消息日志 (解码后)', messagesHtml);
            } else {
                const headersToString = headers => headers ? Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n') : 'N/A';
                modalBodyHtml = createSection('▼ 时序瀑布流', timingContent) +
                                createSection('▼ 调用堆栈 (Initiator)', this.Utils.parseInitiator(req.initiator), false, true) +
                                createSection('▼ 基本信息', `URL: ${this.Utils.resolveToFullUrl(req.url)}\n方法: ${req.method}\n状态码: ${req.response.status || 'N/A'}`) +
                                createSection('▼ 响应头', headersToString(req.response.headers)) +
                                createSection('▼ 请求头', headersToString(req.request.headers)) +
                                createSection('▼ 请求体', req.request.body, typeof req.request.body === 'object') +
                                createSection('▼ 响应体', req.response.body, typeof req.response.body === 'object');
            }

            const modal = this.createModal(`${req.type} 深度稽查`, modalBodyHtml);
            modal.querySelectorAll('.inspection-section-header').forEach(header => {
                header.addEventListener('click', () => header.nextElementSibling.classList.toggle('collapsed'));
            });
            modal.querySelectorAll('.json-collapsible').forEach(el => {
                el.addEventListener('click', (e) => { e.stopPropagation(); el.classList.toggle('collapsed'); });
            });
        },
        createModal(title, bodyHtml) {
            const modalOverlay = document.createElement('div');
            modalOverlay.className = 'fx-modal-overlay';
            modalOverlay.innerHTML = `<div class="fx-modal-content">
                <div class="fx-modal-header"><span>${title}</span><button class="close-btn" title="关闭" style="background:none;border:none;color:white;font-size:24px;cursor:pointer;">&times;</button></div>
                <div class="fx-modal-body">${bodyHtml}</div>
            </div>`;
            document.body.appendChild(modalOverlay);
            const closeModal = () => modalOverlay.remove();
            modalOverlay.querySelector('.close-btn').addEventListener('click', closeModal);
            modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
            return modalOverlay;
        },
        generateCurlCommand(req) {
            let curl = `curl '${this.Utils.resolveToFullUrl(req.url)}' \\\n`;
            if (req.method !== 'GET') curl += `  -X ${req.method} \\\n`;
            for (const key in req.request.headers) {
                if (key.startsWith(':') || ['content-length', 'host', 'cookie'].includes(key.toLowerCase())) continue;
                curl += `  -H '${key}: ${String(req.request.headers[key]).replace(/'/g, "'\\''")}' \\\n`;
            }
            if (req.request.body) {
                const body = typeof req.request.body === 'string' ? req.request.body : JSON.stringify(req.request.body);
                curl += `  --data-raw '${body.replace(/'/g, "'\\''")}' \\\n`;
            }
            return curl.trim().replace(/\\$/, '') + ' --compressed';
        },
        generateFetchSnippet(req) {
            const url = this.Utils.resolveToFullUrl(req.url);
            const options = { method: req.method, headers: req.request.headers };
            if (req.request.body) {
                options.body = typeof req.request.body === 'string' ? req.request.body : JSON.stringify(req.request.body);
            }
            ['cookie', 'host', 'content-length'].forEach(h => delete options.headers[h]);
            return `fetch('${url}', ${JSON.stringify(options, null, 2)});`;
        },

        // =================================================================================
        // Part 8: 初始化 (Initialization)
        // =================================================================================
        init() {
            this.Core.init();
            const initializeUIWhenReady = () => {
                if (document.body) {
                    this.UI.init();
                } else {
                    document.addEventListener('DOMContentLoaded', () => this.UI.init(), { once: true });
                }
            };
            initializeUIWhenReady();
        }
    };

    // Kick off the sniffer
    SnifferV31.init();

})();
