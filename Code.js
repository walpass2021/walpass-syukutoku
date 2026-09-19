/**
 * ==============================================================================
 * WALPASS パン注文システム (特定高校サッカー部向け環境)
 * バックエンドスクリプト (GAS)
 * 
 * 【主要機能】
 * 1. 注文受付 (LIFF / フロントエンド連携)
 * 2. 注文履歴確認
 * 3. ポイント管理 (1個=1pt / 25pt・50ptマイルストーン自動判定)
 * 4. PayPay受取リンク自動Push配信 (Flex Message)
 * 5. 配送カレンダー連携
 * 6. パン配布リストPDF・発注集計表作成
 * 7. LINE公式アカウント一斉メッセージ配信
 * ==============================================================================
 */

/**
 * ユーティリティ：ヘッダー行から特定の名前の列を柔軟に探す（大文字小文字・空白・アンダースコアを無視）
 */
function findColIndex(headers, targetName) {
    if (!headers || !targetName) return -1;
    var normTarget = targetName.toLowerCase().replace(/[\s_]/g, '');
    for (var i = 0; i < headers.length; i++) {
        var h = String(headers[i] || "").toLowerCase().replace(/[\s_]/g, '');
        if (h === normTarget) return i;
    }
    return -1;
}

function parseNumberSafe(val) {
    if (val === undefined || val === null || val === "") return 0;
    var str = String(val).replace(/[０-９]/g, function (s) {
        return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
    });
    return Number(str) || 0;
}

/**
 * 送信テキスト・名前を照合用に強力に正規化
 * 1. 前後の挨拶・敬称・助詞の除去（「〇〇です」「私、〇〇です」「選手」「君」など）
 * 2. 異体字（旧字体/新字体）の吸収（斉/齊/齋/斎、渡辺/渡邊/渡邉、高/髙、崎/﨑、沢/澤、嶋/島、塚/塚、德/徳、吉/𠮷など）
 * 3. ひらがな・カタカナの相互変換（ひらがな送信もKanaと照合可能に）
 * 4. 空白・特殊記号の除去
 */
function normalizeNameForMatching(str) {
    if (!str) return "";
    var s = String(str).trim();

    // 1. 空白・タブ・改行・記号の除去
    s = s.replace(/[\s　\t\r\n]/g, '');

    // 2. 接頭辞の除去（「私の名前は」「名前：」「氏名:」「登録:」等）
    s = s.replace(/^(私(の名前)?は?|ぼく(の名前)?は?|僕(の名前)?は?|俺(の名前)?は?|名前[:：]?|氏名[:：]?|選手名[:：]?|登録[:：]?|連携[:：]?)/gi, '');

    // 3. 接尾辞の除去（「です！」「でーす」「選手」「くん」「君」「さん」「様」「ちゃん」「！」など）
    s = s.replace(/(です|でーす|でした|だよ|だす|選手|くん|君|さん|さま|様|ちゃん|！|!|。)+$/gi, '');

    // 4. 残った空白等を再度除去
    s = s.replace(/[\s　]/g, '');

    return s;
}

/**
 * 漢字の異体字（旧字体・俗字・表記揺れ）を代表文字に統一
 */
function normalizeKanjiVariants(str) {
    if (!str) return "";
    var s = String(str);
    
    var variantMap = {
        '齊': '斉', '齋': '斉', '斎': '斉', '齎': '斉',
        '邊': '辺', '邉': '辺', '辺': '辺',
        '髙': '高',
        '﨑': '崎', '埼': '崎',
        '澤': '沢',
        '嶋': '島',
        '藪': '薮', '籔': '薮',
        '塚': '塚',
        '德': '徳',
        '𠮷': '吉',
        '瀨': '瀬',
        '櫻': '桜',
        '檜': '桧',
        '廣': '広',
        '濱': '浜', '濵': '浜',
        '龍': '竜',
        '國': '国',
        '鐵': '鉄',
        '黑': '黒'
    };
    
    for (var k in variantMap) {
        if (s.indexOf(k) !== -1) {
            s = s.split(k).join(variantMap[k]);
        }
    }
    return s;
}

/**
 * ひらがなをカタカナに変換（ふりがな比較用）
 */
function hiraToKana(str) {
    if (!str) return "";
    return String(str).replace(/[\u3041-\u3096]/g, function(ch) {
        return String.fromCharCode(ch.charCodeAt(0) + 0x60);
    });
}

/**
 * Usersシートの行リストから、送信テキストに合致するユーザーを柔軟に検索
 */
function findMatchingUserRow(uData, colName, colKana, incomingText) {
    if (!incomingText || !uData || uData.length === 0) return null;

    var cleanIncoming = normalizeNameForMatching(incomingText);
    if (!cleanIncoming) return null;

    var normIncoming = normalizeKanjiVariants(cleanIncoming);
    var kanaIncoming = hiraToKana(cleanIncoming);

    // 1st Pass: 漢字名または異体字正規化名での照合
    for (var i = 0; i < uData.length; i++) {
        var rawName = String(uData[i][colName] || "").trim();
        if (!rawName) continue;

        var cleanSheetName = normalizeNameForMatching(rawName);
        var normSheetName = normalizeKanjiVariants(cleanSheetName);

        // 完全一致（正規化後）
        if (normSheetName === normIncoming) {
            return { index: i, rawName: rawName };
        }
    }

    // 2nd Pass: かな/カナでの照合 (Kana列が存在する場合)
    if (colKana !== -1) {
        for (var i = 0; i < uData.length; i++) {
            var rawKana = String(uData[i][colKana] || "").trim();
            if (!rawKana) continue;

            var cleanSheetKana = hiraToKana(normalizeNameForMatching(rawKana));
            if (cleanSheetKana && (cleanSheetKana === kanaIncoming)) {
                return { index: i, rawName: String(uData[i][colName] || "").trim() };
            }
        }
    }

    // 3rd Pass: 部分一致（名前の文字数が2文字以上の場合）
    if (normIncoming.length >= 2) {
        for (var i = 0; i < uData.length; i++) {
            var rawName = String(uData[i][colName] || "").trim();
            if (!rawName) continue;

            var cleanSheetName = normalizeNameForMatching(rawName);
            var normSheetName = normalizeKanjiVariants(cleanSheetName);

            if (normSheetName && (normSheetName.indexOf(normIncoming) !== -1 || normIncoming.indexOf(normSheetName) !== -1)) {
                return { index: i, rawName: rawName };
            }
        }
    }

    // 4th Pass: かな部分一致（かなが3文字以上の場合）
    if (colKana !== -1 && kanaIncoming.length >= 3) {
        for (var i = 0; i < uData.length; i++) {
            var rawKana = String(uData[i][colKana] || "").trim();
            if (!rawKana) continue;

            var cleanSheetKana = hiraToKana(normalizeNameForMatching(rawKana));
            if (cleanSheetKana && (cleanSheetKana.indexOf(kanaIncoming) !== -1 || kanaIncoming.indexOf(cleanSheetKana) !== -1)) {
                return { index: i, rawName: String(uData[i][colName] || "").trim() };
            }
        }
    }

    return null;
}

/**
 * LINE Messaging API Webhook & Frontend API Endpoint (POST)
 */
function doPost(e) {
    try {
        var postData = JSON.parse(e.postData.contents);

        // === API機能 (フロントエンドからPOSTされた場合) ===
        if (postData.action) {
            var result;
            if (postData.action === 'submitOrders') {
                result = submitOrders(postData.payload);
            } else if (postData.action === 'bindLineIdToUser') {
                result = bindLineIdToUser(postData.payload.userId, postData.payload.lineId);
            } else {
                result = JSON.stringify({ success: false, message: "Unknown API action: " + postData.action });
            }
            return ContentService.createTextOutput(result).setMimeType(ContentService.MimeType.JSON);
        }

        // === LINE Messaging API Webhook (LINEチャットからのメッセージ受信) ===
        var events = postData.events;
        if (!events || events.length === 0) return ContentService.createTextOutput(JSON.stringify({ status: 'ok' })).setMimeType(ContentService.MimeType.JSON);

        var ss = SpreadsheetApp.getActiveSpreadsheet();
        var inboxSheet = ss.getSheetByName('LINE受信箱');
        if (!inboxSheet) {
            inboxSheet = ss.insertSheet('LINE受信箱');
            inboxSheet.getRange(1, 1, 1, 3).setValues([["受信日時", "送信されたお名前", "LINEユーザーID"]]);
        }

        var usersSheet = ss.getSheetByName('Users');

        events.forEach(function (event) {
            if (event.type === "message" && event.message.type === "text") {
                var text = String(event.message.text || "").trim();
                var lineId = event.source.userId;
                var replyToken = event.replyToken;

                // 1. LINE受信箱への記録
                var lastRow = inboxSheet.getLastRow();
                var alreadyExists = false;
                if (lastRow >= 2) {
                    var lineIdsInSheet = inboxSheet.getRange(2, 3, lastRow - 1, 1).getValues();
                    for (var i = 0; i < lineIdsInSheet.length; i++) {
                        if (String(lineIdsInSheet[i][0]).trim() === lineId) {
                            alreadyExists = true;
                            break;
                        }
                    }
                }
                if (!alreadyExists) {
                    inboxSheet.appendRow([new Date(), text, lineId]);
                }

                // 2. ポイント照会キーワード判定（「ポイント」「pt」「ポイント確認」等）
                var normKeyword = String(text || "").trim().toLowerCase().replace(/[\s　]/g, '');
                var isPointQuery = /^(ポイント|pt|マイポイント|ポイント確認|何ポイント|ポイント数|保有ポイント)$/.test(normKeyword);

                if (isPointQuery && usersSheet) {
                    var uLastRow = usersSheet.getLastRow();
                    if (uLastRow >= 2) {
                        var uHeaders = usersSheet.getRange(1, 1, 1, usersSheet.getLastColumn()).getValues()[0];
                        var colName = findColIndex(uHeaders, 'Name') !== -1 ? findColIndex(uHeaders, 'Name') : findColIndex(uHeaders, '名前');
                        var colLineId = findColIndex(uHeaders, 'LINE_ID') !== -1 ? findColIndex(uHeaders, 'LINE_ID') : findColIndex(uHeaders, 'LINE ID');
                        var colPoints = findColIndex(uHeaders, '累計ポイント');
                        var col25Given = findColIndex(uHeaders, '25pt特典付与済');
                        var col50Given = findColIndex(uHeaders, '50pt特典付与済');
                        var colTeam = findColIndex(uHeaders, 'チーム記号');

                        var uData = usersSheet.getRange(2, 1, uLastRow - 1, uHeaders.length).getValues();
                        var foundUser = null;

                        for (var ui = 0; ui < uData.length; ui++) {
                            var sheetLineVal = colLineId !== -1 ? String(uData[ui][colLineId] || "") : "";
                            if (sheetLineVal && sheetLineVal.indexOf(lineId) !== -1) {
                                foundUser = {
                                    name: colName !== -1 ? String(uData[ui][colName] || "").trim() : "選手",
                                    points: colPoints !== -1 ? Number(uData[ui][colPoints]) || 0 : 0,
                                    is25: col25Given !== -1 ? (uData[ui][col25Given] === true || String(uData[ui][col25Given]).trim() === "TRUE") : false,
                                    is50: col50Given !== -1 ? (uData[ui][col50Given] === true || String(uData[ui][col50Given]).trim() === "TRUE") : false,
                                    teamCode: colTeam !== -1 ? String(uData[ui][colTeam] || "").trim() : ""
                                };
                                break;
                            }
                        }

                        if (foundUser && replyToken) {
                            var teamPoints = 0;
                            try {
                                var menuSheet = ss.getSheetByName('メニュー設定');
                                if (menuSheet && foundUser.teamCode) {
                                    var mHeaders = menuSheet.getRange(1, 1, 1, menuSheet.getLastColumn()).getValues()[0];
                                    var mColTeam = findColIndex(mHeaders, 'チーム記号');
                                    var mColTeamPts = findColIndex(mHeaders, 'チーム累計ポイント');
                                    if (mColTeamPts === -1) mColTeamPts = findColIndex(mHeaders, 'チームポイント');
                                    if (mColTeam !== -1 && mColTeamPts !== -1) {
                                        var mData = menuSheet.getRange(2, 1, menuSheet.getLastRow() - 1, menuSheet.getLastColumn()).getValues();
                                        for (var mi = 0; mi < mData.length; mi++) {
                                            if (String(mData[mi][mColTeam] || "").trim() === foundUser.teamCode) {
                                                teamPoints = Number(mData[mi][mColTeamPts]) || 0;
                                                break;
                                            }
                                        }
                                    }
                                }
                            } catch (e) {}

                            var pMsg = "⚽ " + foundUser.name + " 選手のアスリートポイント\n\n";
                            pMsg += "【あなたの保有ポイント】\n👉 " + foundUser.points + " pt\n\n";

                            if (!foundUser.is25) {
                                var to25 = Math.max(0, 25 - foundUser.points);
                                pMsg += "🎁 25pt特典(PayPay 200円)：あと " + to25 + " pt\n";
                            } else {
                                pMsg += "🎁 25pt特典(PayPay 200円)：✅ 獲得済！\n";
                            }

                            if (!foundUser.is50) {
                                var to50 = Math.max(0, 50 - foundUser.points);
                                pMsg += "🏆 50pt特典(PayPay 500円)：あと " + to50 + " pt\n\n";
                            } else {
                                pMsg += "🏆 50pt特典(PayPay 500円)：✅ 獲得済！\n\n";
                            }

                            pMsg += "━━━━━━━━━━━━\n";
                            pMsg += "🤝 チーム全体の累計： " + teamPoints + " pt\n";
                            pMsg += "━━━━━━━━━━━━\n\n";
                            pMsg += "※パン1個のご注文につき 選手に1pt / チームに0.5pt が貯まります！";
                            replyLineTextMessage(replyToken, pMsg);
                            return;
                        } else if (replyToken) {
                            replyLineTextMessage(replyToken, "お名前の登録がまだ完了していません。\nスプレッドシートに登録されているお名前（フルネーム）を送信してください。");
                            return;
                        }
                    }
                }

                // 3. Usersシートとの自動照合・LINE ID即時書き込み
                if (usersSheet) {
                    var uLastRow = usersSheet.getLastRow();
                    if (uLastRow >= 2) {
                        var uHeaders = usersSheet.getRange(1, 1, 1, usersSheet.getLastColumn()).getValues()[0];
                        var colName = findColIndex(uHeaders, 'Name');
                        if (colName === -1) colName = findColIndex(uHeaders, '氏名');
                        if (colName === -1) colName = findColIndex(uHeaders, '名前');
                        if (colName === -1) colName = findColIndex(uHeaders, '選手名');
                        if (colName === -1) colName = findColIndex(uHeaders, 'お名前');

                        var colLineId = findColIndex(uHeaders, 'LINE_ID');
                        if (colLineId === -1) colLineId = findColIndex(uHeaders, 'LINE ID');
                        if (colLineId === -1) colLineId = findColIndex(uHeaders, 'LINEID');
                        if (colLineId === -1) colLineId = findColIndex(uHeaders, 'ラインID');
                        if (colLineId === -1) colLineId = findColIndex(uHeaders, 'ライン ID');
                        if (colLineId === -1) colLineId = findColIndex(uHeaders, 'LINEユーザーID');
                        var colKana = findColIndex(uHeaders, 'Kana');
                        if (colKana === -1) colKana = findColIndex(uHeaders, 'ふりがな');
                        if (colKana === -1) colKana = findColIndex(uHeaders, 'フリガナ');
                        if (colKana === -1) colKana = findColIndex(uHeaders, 'カナ');

                        var colTeamCode = findColIndex(uHeaders, 'チーム記号');

                        if (colLineId === -1) {
                            var newHeaders = uHeaders.slice();
                            newHeaders.push('LINE_ID');
                            colLineId = newHeaders.length - 1;
                            usersSheet.getRange(1, 1, 1, newHeaders.length).setValues([newHeaders]);
                            SpreadsheetApp.flush();
                        }

                        var uData = usersSheet.getRange(2, 1, uLastRow - 1, uHeaders.length).getValues();
                        var matchResult = findMatchingUserRow(uData, colName, colKana, text);
                        var matchedUser = matchResult ? matchResult.rawName : null;
                        var matchedRowIdx = matchResult ? matchResult.index + 2 : -1;
                        var targetTeamCode = "";
                        if (matchedRowIdx !== -1 && colTeamCode !== -1) {
                            targetTeamCode = String(uData[matchResult.index][colTeamCode] || "").trim();
                        }

                        if (matchedRowIdx !== -1 && matchedUser) {
                            usersSheet.getRange(matchedRowIdx, colLineId + 1).setValue(lineId);
                            SpreadsheetApp.flush();
                            console.log("doPost Webhook: Auto-bound LINE ID " + lineId + " to " + matchedUser);

                            // チームリッチメニューの即時適用
                            try {
                                var menuConfig = getRichMenuConfig(targetTeamCode);
                                if (menuConfig && menuConfig.richMenuId) {
                                    applyRichMenuToUser(lineId, menuConfig.richMenuId);
                                }
                            } catch (rmErr) {
                                console.error("Rich menu auto-apply error:", rmErr);
                            }

                            // LINEトークへの自動返信
                            if (replyToken) {
                                replyLineTextMessage(replyToken, "✅ " + matchedUser + " 選手、登録が完了しました！🎉\nリッチメニューの「アスリート向け補食パン注文」からご注文いただけます。");
                            }
                        } else if (replyToken) {
                            var cleanIncoming = normalizeNameForMatching(text);
                            var isKanaInput = /^[\u3040-\u309F\u30A0-\u30FF\s　ー・]+$/.test(cleanIncoming);
                            
                            // 2回目以降の失敗かどうかも判定
                            var isRetry = false;
                            if (inboxSheet && lastRow >= 2) {
                                var allInboxRows = inboxSheet.getRange(2, 3, lastRow - 1, 1).getValues();
                                var idCount = 0;
                                for (var k = 0; k < allInboxRows.length; k++) {
                                    if (String(allInboxRows[k][0]).trim() === lineId) idCount++;
                                }
                                if (idCount >= 2) isRetry = true;
                            }

                            if (isKanaInput || isRetry) {
                                replyLineTextMessage(replyToken, "登録リストに名前が見つかりませんでした。\nチームのスタッフの方にご確認ください。");
                            } else {
                                replyLineTextMessage(replyToken, "「" + text + "」が登録リストに見つかりませんでした。\nカタカナ（フルネーム）で入力してみてください。");
                            }
                        }
                    }
                }
            }
        });

        return ContentService.createTextOutput(JSON.stringify({ status: 'ok' })).setMimeType(ContentService.MimeType.JSON);

    } catch (err) {
        console.error("doPost Error:", err);
        return ContentService.createTextOutput(JSON.stringify({ error: String(err) })).setMimeType(ContentService.MimeType.JSON);
    }
}

/**
 * LINE Messaging API 応答メッセージ送信 (Reply)
 */
function replyLineTextMessage(replyToken, text) {
    try {
        var props = PropertiesService.getScriptProperties().getProperties();
        var channelToken = (props['CHANNEL_ACCESS_TOKEN'] || props['channel_access_token'] || props['ChannelAccessToken'] || "").trim();
        if (!channelToken || !replyToken) return;

        var url = 'https://api.line.me/v2/bot/message/reply';
        var payload = {
            replyToken: replyToken,
            messages: [{ type: 'text', text: text }]
        };

        UrlFetchApp.fetch(url, {
            method: 'post',
            headers: {
                'Content-Type': 'application/json; charset=UTF-8',
                'Authorization': 'Bearer ' + channelToken
            },
            payload: JSON.stringify(payload),
            muteHttpExceptions: true
        });
    } catch (e) {
        console.error("replyLineTextMessage error:", e);
    }
}

/**
 * 登録画面からの直接送信用関数 (Frontend から google.script.run で呼ばれる)
 */
function submitRegistration(teamCode, kanjiName, kanaName, lineId) {
    try {
        var ss = SpreadsheetApp.getActiveSpreadsheet();
        var logSheet = ss.getSheetByName('LINE連携ログ');

        if (!logSheet) {
            logSheet = ss.insertSheet('LINE連携ログ');
            logSheet.getRange(1, 1, 1, 5).setValues([["Timestamp", "チーム", "漢字名", "カタカナ名", "LINE ID"]]);
        }

        logSheet.appendRow([new Date(), teamCode || "", kanjiName || "", kanaName || "", lineId || ""]);
        return { success: true, message: "登録が完了しました。" };
    } catch (e) {
        console.error("submitRegistration error:", e);
        throw new Error("登録処理中にエラーが発生しました: " + String(e));
    }
}

/**
 * LINE Messaging API：返信（リプライ）
 */
function replyToUser(replyToken, messageText) {
    var channelToken = PropertiesService.getScriptProperties().getProperty('CHANNEL_ACCESS_TOKEN');
    if (!channelToken) return;

    var url = 'https://api.line.me/v2/bot/message/reply';
    var payload = {
        'replyToken': replyToken,
        'messages': [{ 'type': 'text', 'text': messageText }]
    };

    UrlFetchApp.fetch(url, {
        'headers': {
            'Content-Type': 'application/json; charset=UTF-8',
            'Authorization': 'Bearer ' + channelToken,
        },
        'method': 'post',
        'payload': JSON.stringify(payload)
    });
}

/**
 * Webアプリ エンドポイント (GET)
 */
function doGet(e) {
    var team = e.parameter.team || "";
    var mode = e.parameter.mode || "";

    if (e.parameter['liff.state']) {
        try {
            var stateStr = String(e.parameter['liff.state']);
            var searchStr = stateStr.indexOf('?') !== -1 ? stateStr.split('?')[1] : stateStr;
            var pairs = searchStr.split('&');
            for (var i = 0; i < pairs.length; i++) {
                var kv = pairs[i].split('=');
                if (kv.length === 2) {
                    var key = decodeURIComponent(kv[0]);
                    var val = decodeURIComponent(kv[1]);
                    if (!team && key === 'team') team = val;
                    if (!mode && key === 'mode') mode = val;
                }
            }
        } catch (ex) {
            console.error("liff.state error", ex);
        }
    }

    // === 配送カレンダー機能 ===
    if (mode === 'calendar') {
        const calendarId = getCalendarIdByTeam(team);
        const teamSettings = getUserTeamSettings(null, team);

        try {
            const template = HtmlService.createTemplateFromFile('calendar');
            template.calendarId = calendarId;
            template.teamCode = team;
            template.logoUrl = teamSettings ? teamSettings.logoUrl : "";
            template.themeColor = teamSettings ? teamSettings.themeColor : "#000000";

            return template.evaluate()
                .setTitle('配送カレンダー')
                .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
                .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
        } catch (fileErr) {
            return ContentService.createTextOutput("エラー: calendar.html が見つからないか、中身にエラーがあります。\n" + fileErr.toString());
        }
    }

    // === API機能 (JSONP対応) ===
    if (e && e.parameter && e.parameter.api) {
        var action = e.parameter.api;
        var callback = e.parameter.callback;
        var result;

        try {
            if (action === 'getInitialData') {
                var lineId = e.parameter.lineId || null;
                var teamCode = e.parameter.teamCode || null;
                var reqMode = e.parameter.mode || null;
                result = getInitialData(lineId, teamCode, reqMode);
            } else if (action === 'getOrderHistory') {
                var lineId = e.parameter.lineId || null;
                var userId = e.parameter.userId || null;
                result = getOrderHistory(lineId, userId);
            } else if (action === 'getUserTeamSettings') {
                var lineId = e.parameter.lineId || null;
                var teamCode = e.parameter.teamCode || null;
                result = getUserTeamSettings(lineId, teamCode);
            } else if (action === 'submitOrders') {
                var data = e.parameter.data ? JSON.parse(e.parameter.data) : {};
                result = submitOrders(data);
            } else if (action === 'bindLineIdToUser') {
                var uid = e.parameter.userId || '';
                var lid = e.parameter.lineId || '';
                var uname = e.parameter.userName || '';
                result = bindLineIdToUser(uid, lid, uname);
            } else if (action === 'getCalendarEvents') {
                var calId = e.parameter.calendarId || null;
                result = getCalendarEvents(calId);
            } else if (action === 'getPointSummary') {
                var lineId = e.parameter.lineId || null;
                var userId = e.parameter.userId || null;
                result = getPointSummary(lineId, userId);
            } else {
                result = { error: "Unknown API action: " + action };
            }
        } catch (err) {
            result = { error: err.toString() };
        }

        if (callback) {
            var output = callback + '(' + JSON.stringify(result) + ');';
            return ContentService.createTextOutput(output).setMimeType(ContentService.MimeType.JAVASCRIPT);
        } else {
            return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
        }
    }

    // === メインHTML出力 ===
    var scriptProps = PropertiesService.getScriptProperties().getProperties();
    var liffId = (scriptProps['LIFF_ID'] || scriptProps['liff_id'] || scriptProps['LiffId'] || scriptProps['liffId'] || "").trim();
    var currentUrl = "";
    try {
        currentUrl = ScriptApp.getService().getUrl();
    } catch (urlErr) {
        console.warn("ScriptApp.getService().getUrl() error:", urlErr);
    }

    var htmlOutput = HtmlService.createHtmlOutputFromFile('index');
    htmlOutput.append('<script>' +
        'var _gasInjectedTeam = ' + JSON.stringify(team) + ';' +
        'var _gasInjectedMode = ' + JSON.stringify(mode) + ';' +
        'var _gasInjectedLiffId = ' + JSON.stringify(liffId) + ';' +
        'var _gasInjectedApiUrl = ' + JSON.stringify(currentUrl) + ';' +
        '</script>');

    return htmlOutput
        .setTitle('WALPASS パン注文')
        .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 初期データ取得（商品、ユーザー、ルール、チーム設定、ポイント情報）
 */
function getInitialData(lineId, urlTeamCode, mode) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    var productsSheet = ss.getSheetByName('Products');
    var products = getDataFromSheet(productsSheet);

    var rulesSheet = ss.getSheetByName('DeliveryRules');
    var rules = getDataFromSheet(rulesSheet);

    var usersSheet = ss.getSheetByName('Users');
    var allUsersObj = getDataFromSheet(usersSheet);

    var isBound = false;
    var boundUserName = "";
    var filteredUsers = [];
    var userPoints = 0;
    var is25Given = false;
    var is50Given = false;

    if (allUsersObj.length > 0) {
        if (lineId) {
            for (let i = 0; i < allUsersObj.length; i++) {
                const u = allUsersObj[i];
                const sheetLineIdValue = String(u['LINE_ID'] || u['LINE ID'] || "").replace(/，/g, ",").trim();
                const sheetLineIds = sheetLineIdValue.split(',').map(function(s) { return s.trim(); });
                
                if (sheetLineIds.indexOf(lineId) !== -1) {
                    var tempName = String(u['Name'] || "").trim();
                    if (tempName && tempName !== "未設定" && tempName !== "未登録" && tempName !== "仮登録") {
                        isBound = true;
                        boundUserName = tempName;
                        filteredUsers.push(u);
                        userPoints = Number(u['累計ポイント']) || 0;
                        is25Given = (u['25pt特典付与済'] === true || String(u['25pt特典付与済']).trim() === "TRUE" || String(u['25pt特典付与済']).trim() === "配布済");
                        is50Given = (u['50pt特典付与済'] === true || String(u['50pt特典付与済']).trim() === "TRUE" || String(u['50pt特典付与済']).trim() === "配布済");
                        break;
                    }
                }
            }
        }

        if (!isBound) {
            for (let i = 0; i < allUsersObj.length; i++) {
                const u = allUsersObj[i];
                const teamCode = String(u['チーム記号'] || "").trim();
                if (!urlTeamCode || urlTeamCode === 'null' || teamCode === urlTeamCode) {
                    filteredUsers.push(u);
                }
            }
        }
    }

    var availableTeams = [];
    var menuHeaders = [];
    var menuData = [];
    var menuSheet = ss.getSheetByName('メニュー設定');
    if (menuSheet) {
        var menuLastRow = menuSheet.getLastRow();
        if (menuLastRow >= 2) {
            var menuMaxCol = Math.max(menuSheet.getLastColumn(), 1);
            menuHeaders = menuSheet.getRange(1, 1, 1, menuMaxCol).getValues()[0];
            menuData = menuSheet.getRange(2, 1, menuLastRow - 1, menuMaxCol).getValues();
            
            var colTeam = findColIndex(menuHeaders, 'チーム記号');
            if (colTeam === -1) colTeam = 0;

            for (var mi = 0; mi < menuData.length; mi++) {
                var tc = String(menuData[mi][colTeam] || "").trim();
                if (tc) {
                    availableTeams.push({ code: tc });
                }
            }
        }
    }

    var orders = [];
    if (mode === 'history' && isBound && filteredUsers.length > 0) {
        var historyRes = getOrderHistory(lineId, filteredUsers[0].UserID);
        if (historyRes && historyRes.success) {
            orders = historyRes.orders;
        }
    }

    var teamPoints = 0;
    var colTeamPoints = findColIndex(menuHeaders, 'チーム累計ポイント');
    if (colTeamPoints === -1) colTeamPoints = findColIndex(menuHeaders, 'チームポイント');
    if (colTeamPoints !== -1 && menuData.length > 0) {
        var targetTC = (filteredUsers.length > 0 && filteredUsers[0]['チーム記号']) ? String(filteredUsers[0]['チーム記号']).trim() : (urlTeamCode || "");
        for (var mi = 0; mi < menuData.length; mi++) {
            if (!targetTC || String(menuData[mi][colTeam] || "").trim() === targetTC) {
                teamPoints = Number(menuData[mi][colTeamPoints]) || 0;
                break;
            }
        }
    }

    return {
        products: products,
        users: filteredUsers,
        rules: rules,
        isBound: isBound,
        boundUserName: boundUserName,
        availableTeams: availableTeams,
        urlTeamCode: urlTeamCode,
        teamSettings: getUserTeamSettings(lineId, urlTeamCode, allUsersObj, menuData, menuHeaders),
        orders: orders,
        points: userPoints,
        teamPoints: teamPoints,
        is25Given: is25Given,
        is50Given: is50Given
    };
}

/**
 * 注文履歴の取得
 */
function getOrderHistory(lineId, directUserId) {
    var result = { success: false, message: "不明なエラー" };
    try {
        if (!lineId && !directUserId) {
            result.message = "LINE IDが見つかりません。名前を再選択してください。";
            return result;
        }

        const ss = SpreadsheetApp.getActiveSpreadsheet();
        const usersSheet = ss.getSheetByName('Users');
        const ordersSheet = ss.getSheetByName('Orders');
        if (!usersSheet || !ordersSheet) {
            result.message = "必要なシートが見つかりません。";
            return result;
        }

        var userId = directUserId || null;
        var userName = null;

        const usersData = getDataFromSheet(usersSheet);
        for (let i = 0; i < usersData.length; i++) {
            const uLineId = String(usersData[i]['LINE_ID'] || usersData[i]['LINE ID'] || "").trim();
            const uId = String(usersData[i]['UserID'] || "").trim();

            if ((lineId && uLineId === lineId) || (userId && uId === userId)) {
                userId = uId || userId;
                userName = String(usersData[i]['Name'] || "").trim();
                break;
            }
        }

        if (!userId && !userName) {
            result.message = "ユーザー情報が未登録です。名前を選択し直してください。";
            return result;
        }

        const ordersData = getDataFromSheet(ordersSheet);
        const myOrders = ordersData.filter(function (row) {
            const rowUid = String(row.UserID || "").trim();
            const rowUName = String(row.UserName || "").trim();
            return (userId && rowUid === userId) || (userName && rowUName === userName);
        });

        myOrders.sort(function (a, b) {
            var dateA = new Date(String(a.OrderDate).replace(/-/g, '/'));
            var dateB = new Date(String(b.OrderDate).replace(/-/g, '/'));
            return dateA - dateB;
        });

        var safeOrders = myOrders.map(function (row) {
            var dateVal = row.OrderDate;
            var dateStr = "";
            if (dateVal instanceof Date) {
                var y = dateVal.getFullYear();
                var m = ("0" + (dateVal.getMonth() + 1)).slice(-2);
                var d = ("0" + dateVal.getDate()).slice(-2);
                dateStr = y + "/" + m + "/" + d;
            } else {
                dateStr = String(dateVal || "");
            }

            return {
                Timestamp: String(row.Timestamp || ""),
                Category: String(row.Category || ""),
                UserID: String(row.UserID || ""),
                UserName: String(row.UserName || ""),
                OrderDate: dateStr,
                ProductID: String(row.ProductID || ""),
                ProductName: String(row.ProductName || ""),
                Quantity: parseNumberSafe(row.Quantity),
                単価: parseNumberSafe(row['単価'])
            };
        });

        result.success = true;
        result.userName = userName;
        result.userId = userId;
        result.orders = safeOrders;
        return result;

    } catch (e) {
        console.error("getOrderHistory error:", e);
        result.message = "注文履歴の取得中にエラーが発生しました: " + String(e);
        return result;
    }
}

/**
 * ユーザーIDとLINE IDの紐付け処理
 */
function bindLineIdToUser(userId, lineId, userName) {
    try {
        if (!lineId || (!userId && !userName)) {
            return JSON.stringify({ success: false, message: "ユーザー情報またはLINE IDが指定されていません。" });
        }

        var ss = SpreadsheetApp.getActiveSpreadsheet();
        var usersSheet = ss.getSheetByName('Users');
        if (!usersSheet) {
            return JSON.stringify({ success: false, message: "Usersシートが見つかりません。" });
        }

        var lastRow = usersSheet.getLastRow();
        if (lastRow < 2) {
            return JSON.stringify({ success: false, message: "Usersシートにデータがありません。" });
        }

        var headers = usersSheet.getRange(1, 1, 1, usersSheet.getLastColumn()).getValues()[0];
        var colUserID = findColIndex(headers, 'UserID');
        if (colUserID === -1) colUserID = findColIndex(headers, 'ユーザーID');
        var colName = findColIndex(headers, 'Name');
        if (colName === -1) colName = findColIndex(headers, '氏名');
        if (colName === -1) colName = findColIndex(headers, '名前');
        if (colName === -1) colName = findColIndex(headers, '選手名');
        var colLineId = findColIndex(headers, 'LINE_ID');
        if (colLineId === -1) colLineId = findColIndex(headers, 'LINE ID');
        if (colLineId === -1) colLineId = findColIndex(headers, 'LINEID');
        if (colLineId === -1) colLineId = findColIndex(headers, 'ラインID');
        if (colLineId === -1) colLineId = findColIndex(headers, 'LINEユーザーID');
        var colTeamCode = findColIndex(headers, 'チーム記号');

        if (colLineId === -1) {
            var newHeaders = headers.slice();
            newHeaders.push('LINE_ID');
            colLineId = newHeaders.length - 1;
            usersSheet.getRange(1, 1, 1, newHeaders.length).setValues([newHeaders]);
            SpreadsheetApp.flush();
        }

        var data = usersSheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
        var targetRowIndex = -1;
        var teamCode = "";

        for (var i = 0; i < data.length; i++) {
            var currentUserId = colUserID !== -1 ? String(data[i][colUserID] || "").trim() : "";
            var currentName = colName !== -1 ? String(data[i][colName] || "").trim() : "";

            var isMatch = false;
            if (userId && currentUserId && currentUserId === String(userId).trim()) {
                isMatch = true;
            } else if (userName && currentName && currentName === String(userName).trim()) {
                isMatch = true;
            }

            if (isMatch) {
                targetRowIndex = i + 2;
                if (colTeamCode !== -1) teamCode = String(data[i][colTeamCode] || "").trim();
                break;
            }
        }

        if (targetRowIndex === -1) {
            return JSON.stringify({ success: false, message: "対象のユーザーが見つかりませんでした (UserID: " + userId + ", Name: " + userName + ")" });
        }

        var cleanLineId = String(lineId).trim();
        usersSheet.getRange(targetRowIndex, colLineId + 1).setValue(cleanLineId);
        SpreadsheetApp.flush();
        console.log("bindLineIdToUser: Bound " + cleanLineId + " to row " + targetRowIndex + " (" + (userName || userId) + ")");

        // チーム別のリッチメニューがあれば即時適用
        try {
            var menuConfig = getRichMenuConfig(teamCode);
            if (menuConfig && menuConfig.richMenuId) {
                applyRichMenuToUser(cleanLineId, menuConfig.richMenuId);
            }
        } catch (menuErr) {
            console.error("Rich menu bind error:", menuErr);
        }

        return JSON.stringify({ success: true, message: "LINE IDの紐付けが完了しました。" });

    } catch (e) {
        console.error("bindLineIdToUser fatal error:", e);
        return JSON.stringify({ success: false, message: "サーバー処理エラー: " + String(e) });
    }
}

/**
 * 注文データをスプレッドシートに保存し、ポイント加算・PayPay特典判定を実行
 */
function submitOrders(orderData) {
    var response = { success: false, message: "不明なエラー" };
    try {
        const ss = SpreadsheetApp.getActiveSpreadsheet();
        const ordersSheet = ss.getSheetByName('Orders');
        const usersSheet = ss.getSheetByName('Users');

        if (!ordersSheet) {
            response.message = "Ordersシートが見つかりません。管理者へ連絡してください。";
            return response;
        }

        const timestamp = new Date();
        let category = orderData.category;
        let userId = orderData.userId;
        const userName = orderData.userName;
        const lineId = orderData.lineId;

        console.log("submitOrders received:", JSON.stringify({ userName: userName, userId: userId, lineId: lineId }));

        var userUnitPrice = 0;
        if (usersSheet) {
            const usersData = getDataFromSheet(usersSheet);
            for (let i = 0; i < usersData.length; i++) {
                const u = usersData[i];
                if (String(u['Name']).trim() === String(userName).trim() ||
                    (lineId && String(u['LINE_ID'] || u['LINE ID'] || "").trim() === String(lineId).trim())) {
                    category = u['Category'] || category;
                    userId = u['UserID'] || userId;
                    userUnitPrice = Number(u['単価'] || u['単価']) || 0;
                    break;
                }
            }
        }

        const productsSheet = ss.getSheetByName('Products');
        const products = productsSheet ? getDataFromSheet(productsSheet) : [];
        const prodMap = {};
        products.forEach(function (p) {
            var pid = String(p.ProductID || p.productId || p['商品ID'] || "").trim();
            var pname = String(p.Name || p.productName || p['商品名'] || "").trim();
            if (pid) prodMap[pid] = pname;
        });

        const newRows = [];

        // ① 圧縮文字列 (compressed)
        if (orderData.compressed) {
            var items = String(orderData.compressed).split(',');
            items.forEach(function (item) {
                var parts = item.split(':');
                if (parts.length === 3) {
                    var rawDate = parts[0];
                    var productId = parts[1];
                    var quantity = parseInt(parts[2]) || 0;

                    if (quantity > 0) {
                        var formattedDate = rawDate.substring(0, 4) + '/' + rawDate.substring(4, 6) + '/' + rawDate.substring(6, 8);
                        var productName = prodMap[productId] || "商品名未定義";

                        newRows.push([
                            timestamp,
                            category,
                            userId,
                            userName,
                            formattedDate,
                            productId,
                            productName,
                            quantity,
                            userUnitPrice
                        ]);
                    }
                }
            });
        }
        // ② 従来方式
        else if (orderData.orders && orderData.orders.length > 0) {
            orderData.orders.forEach(function (order) {
                if (order.quantity > 0) {
                    newRows.push([
                        timestamp,
                        category,
                        userId,
                        userName,
                        order.date,
                        order.productId,
                        order.productName,
                        order.quantity,
                        userUnitPrice
                    ]);
                }
            });
        }

        if (newRows.length > 0) {
            // 上書き保存（同日注文の削除）
            if (orderData.isOverwrite === true || orderData.isOverwrite === "true") {
                var overwriteDates = newRows.map(function(row) {
                    return normalizeDateStringForGAS(row[4]);
                });

                var lastRow = ordersSheet.getLastRow();
                if (lastRow > 1) {
                    var headers = ordersSheet.getRange(1, 1, 1, ordersSheet.getLastColumn()).getValues()[0];
                    var colUserID = findColIndex(headers, 'UserID');
                    var colUserName = findColIndex(headers, 'UserName');
                    var colOrderDate = findColIndex(headers, 'OrderDate');

                    var idxUserID = colUserID !== -1 ? colUserID : 2; 
                    var idxUserName = colUserName !== -1 ? colUserName : 3; 
                    var idxOrderDate = colOrderDate !== -1 ? colOrderDate : 4; 

                    var allRowsData = ordersSheet.getRange(2, 1, lastRow - 1, headers.length).getValues();

                    for (var i = allRowsData.length - 1; i >= 0; i--) {
                        var rowValues = allRowsData[i];
                        var r = i + 2;
                        
                        var rowTime = rowValues[0];
                        if (rowTime instanceof Date && timestamp instanceof Date) {
                            if (rowTime.getTime() === timestamp.getTime()) {
                                continue;
                            }
                        }

                        var rowUid = String(rowValues[idxUserID] || "").trim();
                        var rowUName = String(rowValues[idxUserName] || "").trim();
                        var rowDateVal = rowValues[idxOrderDate];

                        var userMatch = false;
                        if (userId && rowUid && rowUid === String(userId).trim()) {
                            userMatch = true;
                        } else if (userName && rowUName && rowUName === String(userName).trim()) {
                            userMatch = true;
                        }

                        if (userMatch) {
                            var rowDateStr = normalizeDateStringForGAS(rowDateVal);
                            if (overwriteDates.indexOf(rowDateStr) !== -1) {
                                ordersSheet.deleteRow(r);
                            }
                        }
                    }
                    SpreadsheetApp.flush();
                }
            }

            ordersSheet.getRange(ordersSheet.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
            SpreadsheetApp.flush();
        } else {
            response.message = "注文データが空です。";
            return response;
        }

        // 今回注文された合計個数（1個 = 1pt）
        var totalOrderedCount = 0;
        for (var k = 0; k < newRows.length; k++) {
            totalOrderedCount += (Number(newRows[k][7]) || 0);
        }

        // ユーザー情報の補完とリッチメニュー適用
        var effectiveLineId = lineId;
        var targetTeamCode = null;
        try {
            if (usersSheet) {
                const lastRow = usersSheet.getLastRow();
                var headers = usersSheet.getRange(1, 1, 1, usersSheet.getLastColumn()).getValues()[0];
                var data = usersSheet.getRange(2, 1, Math.max(lastRow - 1, 1), headers.length).getValues();

                const colUserID = findColIndex(headers, 'UserID') !== -1 ? findColIndex(headers, 'UserID') : findColIndex(headers, 'ユーザーID');
                const colName = findColIndex(headers, 'Name') !== -1 ? findColIndex(headers, 'Name') : (findColIndex(headers, '氏名') !== -1 ? findColIndex(headers, '氏名') : findColIndex(headers, '名前'));
                let colLineId = findColIndex(headers, 'LINE_ID');
                if (colLineId === -1) colLineId = findColIndex(headers, 'LINE ID');
                if (colLineId === -1) colLineId = findColIndex(headers, 'LINEID');
                if (colLineId === -1) colLineId = findColIndex(headers, 'ラインID');
                if (colLineId === -1) colLineId = findColIndex(headers, 'LINEユーザーID');
                const colTeamCode = findColIndex(headers, 'チーム記号');

                // LINE ID列が見つからない場合は末尾に追加
                if (colLineId === -1) {
                    var newHeaders = headers.slice();
                    newHeaders.push('LINE_ID');
                    colLineId = newHeaders.length - 1;
                    usersSheet.getRange(1, 1, 1, newHeaders.length).setValues([newHeaders]);
                    SpreadsheetApp.flush();
                }

                let targetRowIndex = -1;

                for (let i = 0; i < data.length; i++) {
                    const sheetUserId = colUserID !== -1 ? String(data[i][colUserID] || "").trim() : "";
                    const sheetName = colName !== -1 ? String(data[i][colName] || "").trim() : "";
                    const sheetLineId = colLineId !== -1 && data[i][colLineId] !== undefined ? String(data[i][colLineId] || "").trim() : "";

                    // UserID または Name で対象ユーザーを確実に特定
                    var matchUser = false;
                    if (userId && sheetUserId && sheetUserId === String(userId).trim()) {
                        matchUser = true;
                    } else if (userName && sheetName && sheetName === String(userName).trim()) {
                        matchUser = true;
                    }

                    if (matchUser) {
                        targetRowIndex = i;
                        if (!effectiveLineId && sheetLineId) effectiveLineId = sheetLineId;
                        if (colTeamCode !== -1) targetTeamCode = String(data[i][colTeamCode] || "").trim();
                        break;
                    }
                }

                // LINE IDが渡されている場合は確実に書き込み
                if (targetRowIndex !== -1 && colLineId !== -1 && lineId && String(lineId).trim() !== "") {
                    var cleanLineId = String(lineId).trim();
                    try {
                        usersSheet.getRange(targetRowIndex + 2, colLineId + 1).setValue(cleanLineId);
                        SpreadsheetApp.flush();
                        effectiveLineId = cleanLineId;
                        console.log("LINE ID successfully written to Users sheet: row " + (targetRowIndex + 2) + ", col " + (colLineId + 1) + ", value: " + cleanLineId);
                    } catch (e) {
                        console.error("submitOrders lineId write error:", e);
                    }
                }

                if (effectiveLineId && effectiveLineId !== "") {
                    var menuConfig = getRichMenuConfig(targetTeamCode);
                    if (menuConfig && menuConfig.richMenuId) {
                        applyRichMenuToUser(effectiveLineId, menuConfig.richMenuId);
                    }
                }
            }
        } catch (subErr) {
            console.error("submitOrders sub-task error:", subErr);
        }

        // === ★ポイント加算＆PayPay特典マイルストーン判定・自動Push送信 ===
        if (totalOrderedCount > 0) {
            try {
                var pointResult = processUserPoints(userId, userName, effectiveLineId, totalOrderedCount);
                response.pointResult = pointResult;
                console.log("Point processed successfully:", pointResult);
            } catch (pointErr) {
                console.error("Point processing error:", pointErr);
            }
        }

        response.success = true;
        response.count = newRows.length;
        response.totalOrderedCount = totalOrderedCount;
        return JSON.stringify(response);

    } catch (e) {
        console.error("submitOrders fatal error:", e);
        return JSON.stringify({ success: false, message: "注文の保存中にエラーが発生しました: " + String(e) });
    }
}

/**
 * ==============================================================================
 * ポイント管理 ＆ PayPay特典自動配信モジュール
 * ==============================================================================
 */

/**
 * PayPay特典ストックシートの取得または作成
 */
function getOrCreatePayPayStockSheet(ss) {
    if (!ss) ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('PayPay特典ストック');
    if (!sheet) {
        sheet = ss.insertSheet('PayPay特典ストック');
        var headers = [
            "特典ID", "マイルストーン", "金額", "PayPay受取URL", "ステータス", 
            "配布先UserID", "配布先氏名", "配布先LINE_ID", "配布日時"
        ];
        sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
        sheet.setFrozenRows(1);
    }
    return sheet;
}

/**
 * スプレッドシートUIから特典シートを初期設定する管理用関数
 */
function initPayPayStockSheet() {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = getOrCreatePayPayStockSheet(ss);
    SpreadsheetApp.getUi().alert('PayPay特典ストック', '「PayPay特典ストック」シートの準備が完了しました。\nPayPay受取URL、マイルストーン(25pt/50pt)、金額(200/500)、ステータス(未使用)を記入してください。', SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * ユーザーのポイント加算とマイルストーン判定・PayPay自動配信
 * @param {string} userId - ユーザーID
 * @param {string} userName - ユーザー名
 * @param {string} lineId - LINE ID
 * @param {number} addedPoints - 今回加算されるポイント（注文個数）
 */
function processUserPoints(userId, userName, lineId, addedPoints) {
    var lock = LockService.getScriptLock();
    var hasLock = false;
    try {
        hasLock = lock.tryLock(30000);
        if (!hasLock) {
            console.warn("processUserPoints: Could not obtain lock");
            return { success: false, message: "Lock timeout" };
        }

        var ss = SpreadsheetApp.getActiveSpreadsheet();
        var usersSheet = ss.getSheetByName('Users');
        if (!usersSheet) return { success: false, message: "Users sheet not found" };

        var lastRow = usersSheet.getLastRow();
        var lastCol = usersSheet.getLastColumn();
        if (lastRow < 1 || lastCol < 1) return { success: false, message: "Users sheet is empty" };

        var headers = usersSheet.getRange(1, 1, 1, lastCol).getValues()[0];

        // 必要な列インデックスの解決
        var colUserID = findColIndex(headers, 'UserID') !== -1 ? findColIndex(headers, 'UserID') : findColIndex(headers, 'ユーザーID');
        var colName = findColIndex(headers, 'Name') !== -1 ? findColIndex(headers, 'Name') : (findColIndex(headers, '氏名') !== -1 ? findColIndex(headers, '氏名') : findColIndex(headers, '名前'));
        var colLineId = findColIndex(headers, 'LINE_ID');
        if (colLineId === -1) colLineId = findColIndex(headers, 'LINE ID');
        if (colLineId === -1) colLineId = findColIndex(headers, 'LINEID');
        if (colLineId === -1) colLineId = findColIndex(headers, 'ラインID');
        var colPoints = findColIndex(headers, '累計ポイント');
        var col25Date = findColIndex(headers, '25pt達成日');
        var col25Given = findColIndex(headers, '25pt特典付与済');
        var col50Date = findColIndex(headers, '50pt達成日');
        var col50Given = findColIndex(headers, '50pt特典付与済');

        // カラムが不足している場合はUsersシートの末尾に自動追加
        var needHeaderUpdate = false;
        var newHeaders = headers.slice();
        if (colPoints === -1) {
            newHeaders.push('累計ポイント');
            colPoints = newHeaders.length - 1;
            needHeaderUpdate = true;
        }
        if (col25Date === -1) {
            newHeaders.push('25pt達成日');
            col25Date = newHeaders.length - 1;
            needHeaderUpdate = true;
        }
        if (col25Given === -1) {
            newHeaders.push('25pt特典付与済');
            col25Given = newHeaders.length - 1;
            needHeaderUpdate = true;
        }
        if (col50Date === -1) {
            newHeaders.push('50pt達成日');
            col50Date = newHeaders.length - 1;
            needHeaderUpdate = true;
        }
        if (col50Given === -1) {
            newHeaders.push('50pt特典付与済');
            col50Given = newHeaders.length - 1;
            needHeaderUpdate = true;
        }

        if (needHeaderUpdate) {
            usersSheet.getRange(1, 1, 1, newHeaders.length).setValues([newHeaders]);
            SpreadsheetApp.flush();
            lastCol = newHeaders.length;
            headers = newHeaders;
        }

        // 対象ユーザーの行を特定
        var allData = usersSheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
        var targetRowIdx = -1;
        for (var i = 0; i < allData.length; i++) {
            var uId = String(allData[i][colUserID] || "").trim();
            var uName = String(allData[i][colName] || "").trim();
            var uLine = colLineId !== -1 ? String(allData[i][colLineId] || "").trim() : "";

            if ((userId && uId === String(userId).trim()) ||
                (userName && uName === String(userName).trim()) ||
                (lineId && uLine === String(lineId).trim())) {
                targetRowIdx = i;
                if (!userName) userName = uName;
                if (!userId) userId = uId;
                if (!lineId && uLine) lineId = uLine;
                break;
            }
        }

        if (targetRowIdx === -1) {
            console.warn("processUserPoints: User not found in Users sheet for userId: " + userId + ", userName: " + userName);
            return { success: false, message: "User not found" };
        }

        var rowNum = targetRowIdx + 2;
        var currentRow = allData[targetRowIdx];

        var currentPoints = Number(currentRow[colPoints]) || 0;
        var newPoints = currentPoints + addedPoints;

        var is25Given = currentRow[col25Given] === true || String(currentRow[col25Given]).trim() === "TRUE" || String(currentRow[col25Given]).trim() === "配布済";
        var is50Given = currentRow[col50Given] === true || String(currentRow[col50Given]).trim() === "TRUE" || String(currentRow[col50Given]).trim() === "配布済";

        // ポイント更新 (選手: 1個=1pt)
        usersSheet.getRange(rowNum, colPoints + 1).setValue(newPoints);

        // ★ チームポイント加算 (1個=0.5pt)
        var colTeam = findColIndex(headers, 'チーム記号');
        var userTeamCode = colTeam !== -1 ? String(currentRow[colTeam] || "").trim() : "";
        var teamAddedPoints = addedPoints * 0.5;

        if (userTeamCode) {
            try {
                var menuSheet = ss.getSheetByName('メニュー設定');
                if (menuSheet) {
                    var mHeaders = menuSheet.getRange(1, 1, 1, menuSheet.getLastColumn()).getValues()[0];
                    var mColTeam = findColIndex(mHeaders, 'チーム記号');
                    var mColTeamPoints = findColIndex(mHeaders, 'チーム累計ポイント');
                    if (mColTeamPoints === -1) mColTeamPoints = findColIndex(mHeaders, 'チームポイント');

                    if (mColTeamPoints === -1) {
                        var newMHeaders = mHeaders.slice();
                        newMHeaders.push('チーム累計ポイント');
                        mColTeamPoints = newMHeaders.length - 1;
                        menuSheet.getRange(1, 1, 1, newMHeaders.length).setValues([newMHeaders]);
                        SpreadsheetApp.flush();
                    }

                    if (mColTeam !== -1) {
                        var mData = menuSheet.getRange(2, 1, menuSheet.getLastRow() - 1, menuSheet.getLastColumn()).getValues();
                        for (var mi = 0; mi < mData.length; mi++) {
                            if (String(mData[mi][mColTeam] || "").trim() === userTeamCode) {
                                var curTeamPts = Number(mData[mi][mColTeamPoints]) || 0;
                                var newTeamPts = Math.round((curTeamPts + teamAddedPoints) * 10) / 10;
                                menuSheet.getRange(mi + 2, mColTeamPoints + 1).setValue(newTeamPts);
                                break;
                            }
                        }
                    }
                }
            } catch (tErr) {
                console.error("Team points update error:", tErr);
            }
        }

        var rewardsTriggered = [];
        var nowStr = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd HH:mm:ss");

        // 25pt マイルストーン判定
        if (newPoints >= 25 && !is25Given) {
            var reward25 = claimAndSendPayPayReward("25pt", 200, userId, userName, lineId);
            if (reward25 && reward25.success) {
                usersSheet.getRange(rowNum, col25Date + 1).setValue(nowStr);
                usersSheet.getRange(rowNum, col25Given + 1).setValue("TRUE");
                rewardsTriggered.push("25pt");
            }
        }

        // 50pt マイルストーン判定
        if (newPoints >= 50 && !is50Given) {
            var reward50 = claimAndSendPayPayReward("50pt", 500, userId, userName, lineId);
            if (reward50 && reward50.success) {
                usersSheet.getRange(rowNum, col50Date + 1).setValue(nowStr);
                usersSheet.getRange(rowNum, col50Given + 1).setValue("TRUE");
                rewardsTriggered.push("50pt");
            }
        }

        SpreadsheetApp.flush();

        return {
            success: true,
            previousPoints: currentPoints,
            newPoints: newPoints,
            rewardsTriggered: rewardsTriggered
        };

    } catch (e) {
        console.error("processUserPoints error:", e);
        return { success: false, error: String(e) };
    } finally {
        if (hasLock) {
            lock.releaseLock();
        }
    }
}

/**
 * 特典ストックシートから該当マイルストーンのPayPay受取URLを1件引き当て、Push送信
 */
function claimAndSendPayPayReward(milestone, amount, userId, userName, lineId) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var stockSheet = getOrCreatePayPayStockSheet(ss);

    var lastRow = stockSheet.getLastRow();
    var lastCol = stockSheet.getLastColumn();
    if (lastRow < 2) {
        console.warn("claimAndSendPayPayReward: PayPay stock sheet has no data rows.");
        logRewardAlert(ss, userId, userName, milestone, amount, "特典ストックが空です（補充してください）");
        return { success: false, reason: "stock_empty" };
    }

    var headers = stockSheet.getRange(1, 1, 1, lastCol).getValues()[0];
    var colMilestone = findColIndex(headers, 'マイルストーン');
    var colAmount = findColIndex(headers, '金額');
    var colUrl = findColIndex(headers, 'PayPay受取URL');
    if (colUrl === -1) colUrl = findColIndex(headers, 'URL');
    var colStatus = findColIndex(headers, 'ステータス');
    var colUserID = findColIndex(headers, '配布先UserID');
    var colUserName = findColIndex(headers, '配布先氏名');
    var colLineId = findColIndex(headers, '配布先LINE_ID');
    var colDate = findColIndex(headers, '配布日時');

    var data = stockSheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
    var matchedRowIdx = -1;
    var targetUrl = "";

    for (var i = 0; i < data.length; i++) {
        var status = String(data[i][colStatus] || "").trim();
        var ms = String(data[i][colMilestone] || "").trim();
        var amt = Number(data[i][colAmount]) || 0;
        var url = String(data[i][colUrl] || "").trim();

        var isMatch = false;
        if (status === "未使用" || status === "") {
            if (ms && (ms.toLowerCase() === milestone.toLowerCase() || ms.indexOf(String(amount)) !== -1)) {
                isMatch = true;
            } else if (amt && amt === Number(amount)) {
                isMatch = true;
            } else if (!ms && !amt) {
                isMatch = true;
            }
        }

        if (isMatch && url) {
            matchedRowIdx = i;
            targetUrl = url;
            break;
        }
    }

    if (matchedRowIdx === -1 || !targetUrl) {
        console.warn("claimAndSendPayPayReward: No available stock for " + milestone + " (￥" + amount + ")");
        logRewardAlert(ss, userId, userName, milestone, amount, "在庫切れ（PayPayリンクが不足しています）");
        return { success: false, reason: "stock_empty" };
    }

    var stockRowNum = matchedRowIdx + 2;
    var now = new Date();

    if (colStatus !== -1) stockSheet.getRange(stockRowNum, colStatus + 1).setValue("配布済");
    if (colUserID !== -1) stockSheet.getRange(stockRowNum, colUserID + 1).setValue(userId || "");
    if (colUserName !== -1) stockSheet.getRange(stockRowNum, colUserName + 1).setValue(userName || "");
    if (colLineId !== -1) stockSheet.getRange(stockRowNum, colLineId + 1).setValue(lineId || "");
    if (colDate !== -1) stockSheet.getRange(stockRowNum, colDate + 1).setValue(now);

    SpreadsheetApp.flush();

    // LINE IDが存在する場合はFlex Message Push送信
    if (lineId && String(lineId).indexOf("U") === 0) {
        try {
            sendPayPayRewardFlexMessage(lineId, userName, milestone, amount, targetUrl);
        } catch (pushErr) {
            console.error("Push send error:", pushErr);
            logRewardAlert(ss, userId, userName, milestone, amount, "Push送信失敗: " + String(pushErr));
        }
    } else {
        console.warn("LINE ID not available for Push notification: " + lineId);
    }

    return { success: true, url: targetUrl };
}

/**
 * サッカー部向けPayPayマイルストーン達成Flex Message送信
 */
function sendPayPayRewardFlexMessage(lineId, userName, milestone, amount, paypayUrl) {
    var props = PropertiesService.getScriptProperties().getProperties();
    var channelToken = (props['CHANNEL_ACCESS_TOKEN'] || props['channel_access_token'] || props['ChannelAccessToken'] || "").trim();
    if (!channelToken) {
        console.error("sendPayPayRewardFlexMessage: CHANNEL_ACCESS_TOKEN is missing.");
        return { success: false, message: "CHANNEL_ACCESS_TOKEN missing" };
    }

    var cleanLineId = String(lineId).replace(/[\s\t\n\r　]/g, '').trim();
    if (!cleanLineId || cleanLineId.indexOf("U") !== 0) {
        return { success: false, message: "Invalid LINE ID: " + cleanLineId };
    }

    var milestoneLabel = milestone === "25pt" ? "25pt 達成！" : (milestone === "50pt" ? "50pt 達成！" : milestone + " 達成！");
    var amountFormatted = "￥" + Number(amount).toLocaleString();

    var flexBubble = {
        "type": "bubble",
        "size": "mega",
        "header": {
            "type": "box",
            "layout": "vertical",
            "backgroundColor": "#14213d",
            "paddingAll": "20px",
            "contents": [
                {
                    "type": "text",
                    "text": "⚽️ WALPASS POINT REWARD",
                    "color": "#fca311",
                    "weight": "bold",
                    "size": "xs",
                    "letterSpacing": "2px"
                },
                {
                    "type": "text",
                    "text": "🎉 " + milestoneLabel,
                    "color": "#ffffff",
                    "weight": "bold",
                    "size": "xl",
                    "margin": "sm"
                },
                {
                    "type": "text",
                    "text": "補食目標達成おめでとうございます！",
                    "color": "#e5e5e5",
                    "size": "xs",
                    "margin": "xs"
                }
            ]
        },
        "body": {
            "type": "box",
            "layout": "vertical",
            "paddingAll": "20px",
            "contents": [
                {
                    "type": "text",
                    "text": (userName ? userName + " 選手" : "部員各位"),
                    "weight": "bold",
                    "size": "md",
                    "color": "#14213d"
                },
                {
                    "type": "box",
                    "layout": "vertical",
                    "margin": "lg",
                    "backgroundColor": "#f8f9fa",
                    "cornerRadius": "10px",
                    "paddingAll": "15px",
                    "contents": [
                        {
                            "type": "box",
                            "layout": "horizontal",
                            "contents": [
                                {
                                    "type": "text",
                                    "text": "獲得特典",
                                    "size": "sm",
                                    "color": "#666666",
                                    "flex": 2
                                },
                                {
                                    "type": "text",
                                    "text": "PayPayマネーライト",
                                    "size": "sm",
                                    "weight": "bold",
                                    "color": "#333333",
                                    "align": "end",
                                    "flex": 4
                                }
                            ]
                        },
                        {
                            "type": "separator",
                            "margin": "md",
                            "color": "#e0e0e0"
                        },
                        {
                            "type": "box",
                            "layout": "horizontal",
                            "margin": "md",
                            "contents": [
                                {
                                    "type": "text",
                                    "text": "特典金額",
                                    "size": "sm",
                                    "color": "#666666",
                                    "flex": 2
                                },
                                {
                                    "type": "text",
                                    "text": amountFormatted,
                                    "size": "lg",
                                    "weight": "bold",
                                    "color": "#ff0033",
                                    "align": "end",
                                    "flex": 4
                                }
                            ]
                        }
                    ]
                },
                {
                    "type": "text",
                    "text": "日々の継続的な補食が強い身体と勝利につながります！下のボタンからPayPayをお受け取りください。",
                    "size": "xs",
                    "color": "#777777",
                    "wrap": true,
                    "margin": "lg",
                    "lineSpacing": "3px"
                }
            ]
        },
        "footer": {
            "type": "box",
            "layout": "vertical",
            "paddingAll": "15px",
            "backgroundColor": "#ffffff",
            "contents": [
                {
                    "type": "button",
                    "style": "primary",
                    "color": "#ff0033",
                    "height": "md",
                    "action": {
                        "type": "uri",
                        "label": "🎁 PayPayを受け取る (" + amountFormatted + ")",
                        "uri": paypayUrl
                    }
                }
            ]
        }
    };

    var pushUrl = 'https://api.line.me/v2/bot/message/push';
    var payload = {
        to: cleanLineId,
        messages: [{
            type: "flex",
            altText: "【WALPASS】🎉 " + milestoneLabel + " 特典（" + amountFormatted + "）が届きました！",
            contents: flexBubble
        }]
    };

    var options = {
        method: "post",
        headers: {
            "Content-Type": "application/json; charset=UTF-8",
            "Authorization": "Bearer " + channelToken
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
    };

    var response = UrlFetchApp.fetch(pushUrl, options);
    var resCode = response.getResponseCode();
    console.log("sendPayPayRewardFlexMessage response (" + resCode + "): " + response.getContentText());

    return { success: (resCode === 200), responseCode: resCode };
}

/**
 * LINE連携ログシートへの特典アラート書き込み
 */
function logRewardAlert(ss, userId, userName, milestone, amount, message) {
    try {
        var logSheet = ss.getSheetByName('LINE連携ログ');
        if (logSheet) {
            logSheet.appendRow([new Date(), "【PayPay特典アラート】", userName + " (" + userId + ")", milestone + " (￥" + amount + ")", message]);
        }
    } catch(e){}
}

/**
 * ユーザーのポイント状況取得API
 */
function getPointSummary(lineId, userId) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var usersSheet = ss.getSheetByName('Users');
    if (!usersSheet) return { success: false, message: "Users sheet not found" };

    var usersData = getDataFromSheet(usersSheet);
    for (var i = 0; i < usersData.length; i++) {
        var u = usersData[i];
        var uId = String(u['UserID'] || "").trim();
        var uLine = String(u['LINE_ID'] || u['LINE ID'] || "").trim();

        if ((userId && uId === userId) || (lineId && uLine === lineId)) {
            var points = Number(u['累計ポイント']) || 0;
            var is25 = (u['25pt特典付与済'] === true || String(u['25pt特典付与済']).trim() === "TRUE" || String(u['25pt特典付与済']).trim() === "配布済");
            var is50 = (u['50pt特典付与済'] === true || String(u['50pt特典付与済']).trim() === "TRUE" || String(u['50pt特典付与済']).trim() === "配布済");

            return {
                success: true,
                userId: uId,
                userName: String(u['Name'] || ""),
                points: points,
                is25Given: is25,
                is50Given: is50,
                nextMilestone: points < 25 ? 25 : (points < 50 ? 50 : null),
                pointsToNext: points < 25 ? (25 - points) : (points < 50 ? (50 - points) : 0)
            };
        }
    }
    return { success: false, message: "User not found" };
}

/**
 * スプレッドシート起動時メニュー
 */
function onOpen() {
    SpreadsheetApp.getUi()
        .createMenu('WALPASSツール')
        .addItem('配送日を選択する', 'showDatePickerSidebar')
        .addSeparator()
        .addItem('【1】パン配布リストPDFを作成', 'showDistributionDialog')
        .addItem('【2】パン発注リスト作成', 'showOrderAggregationDialog')
        .addSeparator()
        .addItem('【3】LINE受信箱からUsersシートへLINE IDを一括反映', 'syncInboxLineIdsToUsersSheet')
        .addItem('【4】リッチメニュー状況を一括確認', 'checkAllRichMenuStatus')
        .addItem('【5】最新のリッチメニューを全員に反映', 'applyRichMenusToAllUsers')
        .addSeparator()
        .addItem('【6】個別お知らせメッセージを送信', 'sendFreeMessage')
        .addSeparator()
        .addItem('【7】PayPay特典ストックの初期設定', 'initPayPayStockSheet')
        .addToUi();
}

function showDatePickerSidebar() {
    const html = HtmlService.createHtmlOutputFromFile('sidebar').setTitle('配送日選択').setWidth(300);
    SpreadsheetApp.getUi().showSidebar(html);
}

function setDatesToCell(datesArrayString) {
    SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getActiveCell().setValue(datesArrayString);
}

/**
 * ==============================================================================
 * リッチメニュー管理
 * ==============================================================================
 */
function applyRichMenuToUser(lineId, richMenuId) {
    try {
        var channelToken = PropertiesService.getScriptProperties().getProperty('CHANNEL_ACCESS_TOKEN');
        if (!channelToken || !lineId) return { success: false, message: "Token or ID missing" };

        lineId = String(lineId).replace(/[\s\t\n\r　\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '').trim();
        richMenuId = String(richMenuId).replace(/[\s\t\n\r　\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '').trim();

        var url = 'https://api.line.me/v2/bot/user/' + lineId + '/richmenu/' + richMenuId;
        var options = {
            'method': 'POST',
            'headers': { 'Authorization': 'Bearer ' + channelToken },
            'contentType': 'application/json',
            'muteHttpExceptions': true
        };

        var response = UrlFetchApp.fetch(url, options);
        var resCode = response.getResponseCode();
        
        if (resCode === 200) {
            return { success: true };
        } else {
            var msg = "Error " + resCode;
            try {
                var json = JSON.parse(response.getContentText());
                if (json.message) msg = json.message;
            } catch(e) {}
            return { success: false, message: msg };
        }
    } catch (e) {
        return { success: false, message: e.toString() };
    }
}

function unlinkRichMenuFromUser(lineId) {
    var channelToken = PropertiesService.getScriptProperties().getProperty('CHANNEL_ACCESS_TOKEN');
    if (!channelToken) return;

    var url = 'https://api.line.me/v2/bot/user/' + lineId + '/richmenu';
    var options = {
        'method': 'DELETE',
        'headers': {
            'Authorization': 'Bearer ' + channelToken
        },
        'muteHttpExceptions': true
    };

    var response = UrlFetchApp.fetch(url, options);
}

/**
 * 特定の LINE ID に現在紐付いているリッチメニューIDを取得する
 */
function getBoundRichMenuId(lineId) {
    if (!lineId) return { status: 404, message: "ID missing" };
    // 極限クレンジング
    lineId = String(lineId).replace(/[\s\t\n\r　\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '').trim();
    
    var channelToken = PropertiesService.getScriptProperties().getProperty('CHANNEL_ACCESS_TOKEN');
    if (!channelToken) return { status: 500, message: "Token missing" };

    var url = 'https://api.line.me/v2/bot/user/' + lineId + '/richmenu';
    var options = {
        'method': 'GET',
        'headers': { 'Authorization': 'Bearer ' + channelToken },
        'muteHttpExceptions': true
    };

    var response = UrlFetchApp.fetch(url, options);
    var resCode = response.getResponseCode();
    var resText = response.getContentText();
    
    // デバッグログに記録
    
    if (resCode === 200) {
        var json = JSON.parse(resText);
        return { status: 200, richMenuId: json.richMenuId };
    } else if (resCode === 404) {
        return { status: 404, message: "Not set" };
    } else {
        var msg = "Error " + resCode;
        try {
            var json = JSON.parse(resText);
            if (json.message) msg = json.message;
        } catch(e) {}
        return { status: resCode, message: msg };
    }
}

/**
 * Usersシート全件のリッチメニュー適用状況（API実態）を確認してシートを更新する
 */
function checkAllRichMenuStatus() {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Users");
    if (!sheet) return;

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var colLineId = findColIndex(headers, 'LINE_ID') !== -1 ? findColIndex(headers, 'LINE_ID') : findColIndex(headers, 'LINE ID');
    var colTeam = findColIndex(headers, 'チーム記号');
    var colStatus = findColIndex(headers, 'リッチメニュー状況');
    var colAppliedMenuId = findColIndex(headers, '適用メニューID');

    if (colLineId === -1 || colTeam === -1 || colStatus === -1) {
        SpreadsheetApp.getUi().alert('エラー', '必要な列が見つかりません。', SpreadsheetApp.getUi().ButtonSet.OK);
        return;
    }

    // 「適用メニューID」列が存在しない場合は、Usersシートの右端に自動でヘッダーを作成する
    if (colAppliedMenuId === -1) {
        var lastCol = sheet.getLastColumn();
        sheet.getRange(1, lastCol + 1).setValue('適用メニューID');
        headers.push('適用メニューID');
        colAppliedMenuId = lastCol; // 新しい列インデックス(0-indexed)
    }

    var data = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    
    // 高速化：設定を一括取得
    var configMap = getRichMenuConfigsMap();
    
    // 高速化：書き込み用配列を準備
    var statusRange = sheet.getRange(2, colStatus + 1, lastRow - 1, 1);
    var statusValues = statusRange.getValues();
    
    var appliedMenuValues = null;
    var appliedMenuRange = null;
    if (colAppliedMenuId !== -1) {
        appliedMenuRange = sheet.getRange(2, colAppliedMenuId + 1, lastRow - 1, 1);
        appliedMenuValues = appliedMenuRange.getValues();
    }
    
    var updateCount = 0;
    for (var i = 0; i < data.length; i++) {
        var lineId = String(data[i][colLineId] || "").trim();
        var teamCode = String(data[i][colTeam] || "").trim();
        var currentStatusValue = String(statusValues[i][0]).trim();
        var currentAppliedMenuId = appliedMenuValues ? String(appliedMenuValues[i][0]).trim() : "";

        var menuConfig = configMap[teamCode] || null;
        var expectedMenuId = menuConfig ? menuConfig.richMenuId : "";

        // すでに最新のメニューIDが適用済みかつ「✅」で始まる表示になっている場合は、LINEサーバーへの通信をスキップして高速化
        if (expectedMenuId && currentAppliedMenuId === expectedMenuId && currentStatusValue.indexOf("✅") === 0) {
            continue;
        }
        
        // 診断情報を生成（キャッシュを利用）
        var status = checkRichMenuStatusForRawData(lineId, teamCode, menuConfig);
        statusValues[i][0] = status;

        // 確認した結果が「✅反映済み」であれば、適用メニューID列に最新のIDを記録する
        if (appliedMenuValues && status.indexOf("✅反映済み") !== -1) {
            appliedMenuValues[i][0] = expectedMenuId;
        }
        updateCount++;
    }
    
    // 高速化：一括書き込み
    statusRange.setValues(statusValues);
    if (appliedMenuRange && appliedMenuValues) {
        appliedMenuRange.setValues(appliedMenuValues);
    }
    
    SpreadsheetApp.flush();
    SpreadsheetApp.getUi().alert('確認完了', updateCount + ' 件の状況を更新しました。', SpreadsheetApp.getUi().ButtonSet.OK);
}

function getRichMenuConfig(teamCode) {
    var map = getRichMenuConfigsMap();
    return map[teamCode] || null;
}

/**
 * チーム設定を一括で取得し、検索用のマップを作成する（高速化用）
 */
function getRichMenuConfigsMap() {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('メニュー設定');
    if (!sheet) return {};

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return {};

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var data = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();

    var colTeam = findColIndex(headers, 'チーム記号');
    var colMenuId = findColIndex(headers, 'メニューID');
    if (colMenuId === -1) colMenuId = findColIndex(headers, 'リッチメニューID');

    var btnIndices = [];
    for (var i = 1; i <= 6; i++) {
        btnIndices.push(findColIndex(headers, 'ボタン' + i));
    }

    var configMap = {};
    for (var i = 0; i < data.length; i++) {
        var teamCode = String(data[i][colTeam]).trim();
        if (!teamCode) continue;

        var urls = btnIndices.map(function(idx) {
            return (idx !== -1) ? String(data[i][idx] || "").trim() : "";
        });
        var rawMenuId = (colMenuId !== -1) ? String(data[i][colMenuId] || "") : "";
        var cleanMenuId = rawMenuId.replace(/[\s\t\n\r　\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '').trim();

        configMap[teamCode] = {
            richMenuId: cleanMenuId,
            urls: urls
        };
    }
    return configMap;
}

/**
 * チーム記号に基づいて、「メニュー設定」シートからGoogleカレンダーIDを取得する
 */

function createApiRichMenus() {
    var channelToken = PropertiesService.getScriptProperties().getProperty('CHANNEL_ACCESS_TOKEN');
    if (!channelToken) { console.log("Token missing"); return; }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('メニュー設定');
    if (!sheet) return;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var colT = findColIndex(headers, 'チーム記号');
    var colM = findColIndex(headers, 'メニューID') !== -1 ? findColIndex(headers, 'メニューID') : findColIndex(headers, 'リッチメニューID');
    var colD = findColIndex(headers, 'リッチメニュードライブ画像ID');
    var btnCols = []; for (var b=1; b<=6; b++) btnCols.push(findColIndex(headers, 'ボタン'+b));
    var data = sheet.getRange(2, 1, lastRow-1, headers.length).getValues();

    for (var i = 0; i < data.length; i++) {
        var team = String(data[i][colT]||"").trim();
        var menuId = String(data[i][colM]||"").trim();
        var driveId = String(data[i][colD]||"").trim();
        if (team && driveId && !menuId) {
            console.log("Creating menu for " + team);
            var areas = []; var gridW = [833, 834, 833]; var gridH = 843;
            var liffUrl = "https://liff.line.me/2009233341-VFgBMdDu?team=" + team;
            for (var r=0; r<2; r++) {
               for (var c=0; c<3; c++) {
                   var url = (btnCols[r*3+c] !== -1) ? String(data[i][btnCols[r*3+c]]||"").trim() : "";
                   var xOffset = 0; for (var k=0; k<c; k++) xOffset += gridW[k];
                   areas.push({
                       "bounds": { "x": xOffset, "y": r*gridH, "width": gridW[c], "height": gridH },
                       "action": { "type": "uri", "uri": url || liffUrl }
                   });
               }
            }
            var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu', {
                'method': 'post', 'headers': { 'Authorization': 'Bearer ' + channelToken, 'Content-Type': 'application/json' },
                'payload': JSON.stringify({ "size": { "width": 2500, "height": 1686 }, "selected": true, "name": team + "Menu", "chatBarText": "メニュー", "areas": areas }),
                'muteHttpExceptions': true
            });
            if (res.getResponseCode() === 200) {
                var newId = JSON.parse(res.getContentText()).richMenuId;
                var blob = DriveApp.getFileById(driveId).getBlob();
                var upload = UrlFetchApp.fetch('https://api-data.line.me/v2/bot/richmenu/'+newId+'/content', {
                    'method': 'post', 'headers': { 'Authorization': 'Bearer ' + channelToken, 'Content-Type': blob.getContentType() },
                    'payload': blob.getBytes(), 'muteHttpExceptions': true
                });
                if (upload.getResponseCode() === 200) {
                    sheet.getRange(i+2, colM+1).setValue(newId);
                    console.log("Success: " + team);
                }
            }
        }
    }
}

/**
 * 【重要】登録済みの全ユーザーに対して、最新のリッチメニューを強制的に反映し直す
 * 反映失敗時は具体的な理由（User not found等）を記録する
 */
/**
 * 【重要】登録済みの全ユーザーに対して、最新のリッチメニューを強制的に反映し直す
 * 反映失敗時は具体的な理由（User not found等）を記録する
 */
function applyRichMenusToAllUsers() {
    var ui = SpreadsheetApp.getUi();
    var response = ui.alert('一括反映の確認', '全ユーザーにリッチメニューを適用し直します。よろしいですか？（未反映の方のみ順次実行します）', ui.ButtonSet.YES_NO);
    if (response !== ui.Button.YES) return;

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var usersSheet = ss.getSheetByName("Users");
    if (!usersSheet) return;

    var lastRow = usersSheet.getLastRow();
    if (lastRow < 2) return;

    var headers = usersSheet.getRange(1, 1, 1, usersSheet.getLastColumn()).getValues()[0];
    var data = usersSheet.getRange(2, 1, lastRow - 1, headers.length).getValues();

    var colLineId = findColIndex(headers, 'LINE_ID') !== -1 ? findColIndex(headers, 'LINE_ID') : findColIndex(headers, 'LINE ID');
    var colTeamCode = findColIndex(headers, 'チーム記号');
    var colStatus = findColIndex(headers, 'リッチメニュー状況');
    var colAppliedMenuId = findColIndex(headers, '適用メニューID');

    if (colLineId === -1 || colTeamCode === -1) {
        ui.alert("列定義が不足しています。");
        return;
    }

    // 「適用メニューID」列が存在しない場合は、Usersシートの右端に自動でヘッダーを作成する
    if (colAppliedMenuId === -1) {
        var lastCol = usersSheet.getLastColumn();
        usersSheet.getRange(1, lastCol + 1).setValue('適用メニューID');
        headers.push('適用メニューID');
        colAppliedMenuId = lastCol; // 新しい列インデックス(0-indexed)
    }

    // 高速化：設定を一括取得
    var configMap = getRichMenuConfigsMap();
    
    // 高速化：書き込み用配列を準備
    var statusRange = usersSheet.getRange(2, colStatus + 1, lastRow - 1, 1);
    var statusValues = statusRange.getValues();

    var appliedMenuValues = null;
    var appliedMenuRange = null;
    if (colAppliedMenuId !== -1) {
        appliedMenuRange = usersSheet.getRange(2, colAppliedMenuId + 1, lastRow - 1, 1);
        appliedMenuValues = appliedMenuRange.getValues();
    }

    var count = 0;
    for (var i = 0; i < data.length; i++) {
        var lineId = String(data[i][colLineId] || "").trim();
        var teamCode = String(data[i][colTeamCode] || "").trim();
        var currentStatusValue = String(statusValues[i][0]).trim();
        var currentAppliedMenuId = appliedMenuValues ? String(appliedMenuValues[i][0]).trim() : "";

        var menuConfig = configMap[teamCode] || null;
        var expectedMenuId = menuConfig ? menuConfig.richMenuId : "";

        // すでに最新 of メニューIDが適用済みかつ「✅」で始まる表示になっている場合は、適用処理をスキップして高速化
        if (expectedMenuId && currentAppliedMenuId === expectedMenuId && currentStatusValue.indexOf("✅") === 0) {
            continue;
        }

        var currentStatus = "";

        if (lineId && teamCode) {
            if (menuConfig && menuConfig.richMenuId) {
                var ids = lineId.replace(/，/g, ",").split(',').map(function(s) { 
                    return String(s).replace(/[\s\t\n\r　\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '').trim(); 
                }).filter(function(s) { return s !== ""; });
                
                var allSuccess = true;
                var pushDetails = [];
                ids.forEach(function(tid) {
                    var res = applyRichMenuToUser(tid, menuConfig.richMenuId);
                    if (res.success) {
                        count++;
                    } else {
                        allSuccess = false;
                        pushDetails.push("Err:" + res.message);
                    }
                    // 帯域幅制限（Rate Limit）を避けるために少し待機
                    Utilities.sleep(200);
                });
                
                if (allSuccess) {
                    currentStatus = "✅反映済み";
                    if (appliedMenuValues) {
                        appliedMenuValues[i][0] = menuConfig.richMenuId;
                    }
                } else {
                    currentStatus = "⚠️一部失敗 (" + pushDetails.join("/") + ")";
                }
            } else {
                currentStatus = "⚠️設定不備(ID無) [" + teamCode + "]";
            }
        } else {
            currentStatus = "⚠️情報不足";
        }

        // 配列を更新
        statusValues[i][0] = currentStatus;
    }
    
    // 高速化：一括書き込み
    statusRange.setValues(statusValues);
    if (appliedMenuRange && appliedMenuValues) {
        appliedMenuRange.setValues(appliedMenuValues);
    }
    
    SpreadsheetApp.flush();
    ui.alert("反映処理が終了しました", count + "枚のメニュー切替に成功しました。", ui.ButtonSet.OK);
}

function checkRichMenuStatusForRawData(lineId, teamCode, cachedMenuConfig) {
    if (!lineId || !teamCode) return "未設定";

    var menuConfig = cachedMenuConfig || getRichMenuConfig(teamCode);
    var expectedMenuId = menuConfig ? menuConfig.richMenuId : null;
    var channelToken = PropertiesService.getScriptProperties().getProperty('CHANNEL_ACCESS_TOKEN');

    var ids = lineId.replace(/，/g, ",").split(',').map(function(s) { 
        return String(s).replace(/[\s\t\n\r　\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '').trim(); 
    }).filter(function(s) { return s !== ""; });
    
    if (ids.length === 0) return "❌ID形式不正";

    var statusParts = [];
    var lastErrorCode = "0";

    ids.forEach(function(id, idx) {
        var label = (ids.length > 1) ? (idx === 0 ? "子:" : "親:") : "";
        
        // 友達か確認（失敗してもリッチメニューの紐付けが優先）
        var profileOk = false;
        try {
            var pRes = UrlFetchApp.fetch('https://api.line.me/v2/bot/user/' + id + '/profile', {
                'headers': { 'Authorization': 'Bearer ' + channelToken }, 'muteHttpExceptions': true
            });
            if (pRes.getResponseCode() === 200) profileOk = true;
        } catch(e) {}

        // リッチメニューの紐付け実態を最優先で確認
        var res = getBoundRichMenuId(id);
        if (res.status === 200) {
            // メニューが紐付いていれば、その時点で実態として「OK」
            if (expectedMenuId && res.richMenuId === expectedMenuId) {
                statusParts.push(label + "✅反映済み");
            } else {
                statusParts.push(label + "⚠️旧メニューあり");
            }
        } else {
            // 紐付けがない場合
            if (profileOk) {
                // 友達だけどメニューがない ＝ 送付待ち
                statusParts.push(label + "❌送付待ち");
            } else {
                // プロフィールもメニューもダメ ＝ 友達登録がないかID間違い
                statusParts.push(label + "⚠️要友達登録");
            }
        }
    });

    return statusParts.join(", ");
}


/**
 * Googleカレンダーからイベント取得
 */

/**
 * ==============================================================================
 * カレンダー ＆ チーム設定
 * ==============================================================================
 */
function getCalendarIdByTeam(teamCode) {
    if (!teamCode) return "";
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('メニュー設定');
    if (!sheet) return "";

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return "";

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var data = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    
    var colTeam = findColIndex(headers, 'チーム記号');
    var colCal = findColIndex(headers, 'カレンダーID');
    if (colCal === -1) colCal = findColIndex(headers, '配送カレンダーID');

    if (colTeam === -1 || colCal === -1) return "";

    for (var i = 0; i < data.length; i++) {
        if (String(data[i][colTeam]).trim() === teamCode) {
            var rawId = String(data[i][colCal] || "");
            var cleanId = rawId.replace(/[\s\t\n\r\u200B-\u200D\uFEFF]/g, '').trim().replace(/[^a-zA-Z0-9@\._-]/g, '');
            return cleanId;
        }
    }
    return "";
}

/**
 * ユーザーのLINE IDからチームを特定し、UIカスタマイズ用設定を返す
 */
function getUserTeamSettings(lineId, urlTeamCode, cachedUsers, cachedMenuData, cachedMenuHeaders) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var targetTeamCode = urlTeamCode || null;

    if (lineId) {
        if (cachedUsers && cachedUsers.length > 0) {
            // キャッシュされたユーザーデータを使用（Usersシートの再ロードを回避して高速化）
            for (let i = 0; i < cachedUsers.length; i++) {
                const u = cachedUsers[i];
                const sheetLineIdValue = String(u['LINE_ID'] || u['LINE ID'] || "").replace(/，/g, ",").trim();
                const sheetLineIds = sheetLineIdValue.split(',').map(function(s) { return s.trim(); });
                if (sheetLineIds.indexOf(lineId) !== -1) {
                    targetTeamCode = String(u['チーム記号'] || "").trim();
                    break;
                }
            }
        } else {
            // 互換性フォールバック：Usersシートから直接読み込み
            const usersSheet = ss.getSheetByName('Users');
            if (usersSheet) {
                const usersLastRow = usersSheet.getLastRow();
                if (usersLastRow >= 2) {
                    const headers = usersSheet.getRange(1, 1, 1, usersSheet.getLastColumn()).getValues()[0];
                    const colLineId = findColIndex(headers, 'LINE_ID') !== -1 ? findColIndex(headers, 'LINE_ID') : findColIndex(headers, 'LINE ID');
                    const colTeamCode = findColIndex(headers, 'チーム記号');
                    
                    if (colLineId !== -1 && colTeamCode !== -1) {
                        const data = usersSheet.getRange(2, 1, usersLastRow - 1, headers.length).getValues();
                        for (let i = 0; i < data.length; i++) {
                            const sheetLineIdValue = String(data[i][colLineId] || "").replace(/，/g, ",").trim();
                            const sheetLineIds = sheetLineIdValue.split(',').map(function(s) { return s.trim(); });
                            if (sheetLineIds.indexOf(lineId) !== -1) {
                                targetTeamCode = String(data[i][colTeamCode] || "").trim();
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    if (!targetTeamCode && urlTeamCode && urlTeamCode !== 'null') {
        targetTeamCode = urlTeamCode;
    }

    var headers = null;
    var menuData = null;

    if (cachedMenuData && cachedMenuHeaders) {
        headers = cachedMenuHeaders;
        menuData = cachedMenuData;
    } else {
        const menuSheet = ss.getSheetByName('メニュー設定');
        if (menuSheet) {
            const menuLastRow = menuSheet.getLastRow();
            if (menuLastRow >= 2) {
                headers = menuSheet.getRange(1, 1, 1, menuSheet.getLastColumn()).getValues()[0];
                menuData = menuSheet.getRange(2, 1, menuLastRow - 1, headers.length).getValues();
            }
        }
    }

    if (menuData && headers && menuData.length > 0) {
        const colTeam = findColIndex(headers, 'チーム記号');
        const colLogo = findColIndex(headers, 'チームロゴ画像URL');
        const colColor = findColIndex(headers, 'テーマカラー');
        const colSubColor = findColIndex(headers, 'サブタイトル色');
        const colCal = findColIndex(headers, 'カレンダーID') !== -1 ? findColIndex(headers, 'カレンダーID') : findColIndex(headers, '配送カレンダーID');

        const colBgImage = findColIndex(headers, 'ヘッダー背景画像URL') !== -1 ? findColIndex(headers, 'ヘッダー背景画像URL') : (findColIndex(headers, '背景画像URL') !== -1 ? findColIndex(headers, '背景画像URL') : findColIndex(headers, 'ヘッダー画像URL'));

        var matchedRowIdx = -1;
        if (targetTeamCode && colTeam !== -1) {
            var normTargetCode = String(targetTeamCode).replace(/[\s\t\n\r　]/g, '').toUpperCase();
            for (var j = 0; j < menuData.length; j++) {
                var normMenuTeam = String(menuData[j][colTeam] || "").replace(/[\s\t\n\r　]/g, '').toUpperCase();
                if (normMenuTeam === normTargetCode) {
                    matchedRowIdx = j;
                    break;
                }
            }
        }

        // チームが未指定、または一致する行が見つからない場合は先頭行（1行目）をデフォルトとして採用
        if (matchedRowIdx === -1) {
            matchedRowIdx = 0;
        }

        var row = menuData[matchedRowIdx];
        var rawLogoUrl = (colLogo !== -1) ? String(row[colLogo] || "").trim() : "";
        var logoUrl = rawLogoUrl;

        // Googleドライブの共有リンクから表示可能なサムネイルURLを生成
        if (logoUrl.indexOf('drive.google.com') !== -1) {
            var driveId = "";
            var m = logoUrl.match(/(?:file\/d\/|id=|\/d\/|open\?id=)([a-zA-Z0-9_-]{20,})/);
            if (m && m[1]) {
                driveId = m[1];
            } else {
                var m2 = logoUrl.match(/[-\w]{25,}/);
                if (m2) driveId = m2[0];
            }
            if (driveId) {
                logoUrl = "https://drive.google.com/thumbnail?id=" + driveId + "&sz=w500";
            }
        }

        // ヘッダー背景画像URLの解決（Googleドライブ対応）
        var rawBgUrl = (colBgImage !== -1) ? String(row[colBgImage] || "").trim() : "";
        var bgImageUrl = rawBgUrl;
        if (bgImageUrl.indexOf('drive.google.com') !== -1) {
            var bgDriveId = "";
            var bgM = bgImageUrl.match(/(?:file\/d\/|id=|\/d\/|open\?id=)([a-zA-Z0-9_-]{20,})/);
            if (bgM && bgM[1]) {
                bgDriveId = bgM[1];
            } else {
                var bgM2 = bgImageUrl.match(/[-\w]{25,}/);
                if (bgM2) bgDriveId = bgM2[0];
            }
            if (bgDriveId) {
                bgImageUrl = "https://drive.google.com/thumbnail?id=" + bgDriveId + "&sz=w800";
            }
        }

        return {
            teamCode: (colTeam !== -1 && row[colTeam]) ? String(row[colTeam]).trim() : targetTeamCode,
            logoUrl: logoUrl,
            bgImageUrl: bgImageUrl,
            themeColor: (colColor !== -1 && row[colColor]) ? String(row[colColor]).trim() : "#14213d",
            subtitleColor: (colSubColor !== -1 && row[colSubColor]) ? String(row[colSubColor]).trim() : null,
            calendarId: (colCal !== -1 && row[colCal]) ? String(row[colCal]).replace(/[\s\t\n\r　\u200B-\u200D\uFEFF]/g, '').trim() : ""
        };
    }
    return null;
}

function getDataFromSheet(sheet) {
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 2) return [];
    const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    return values.map(function (row) {
        const obj = {};
        headers.forEach(function (header, index) {
            obj[header] = row[index];
        });
        return obj;
    });
}

/**
 * 初期セットアップ用：シート作成
 */

function getCalendarEvents(calendarId) {
    try {
        if (!calendarId) return [];
        var cal = CalendarApp.getCalendarById(calendarId);
        if (!cal) return { error: "Not found (ID: [" + calendarId + "])" };
        var now = new Date();
        var events = cal.getEvents(new Date(now.getFullYear(), now.getMonth()-1, 1), new Date(now.getFullYear(), now.getMonth()+2, 0));
        return events.map(function(e) {
            return {
                title: e.getTitle(),
                start: e.getStartTime().toISOString(),
                end: e.getEndTime().toISOString(),
                color: getHexColorForGCalIndex(e.getColor()),
                allDay: e.isAllDayEvent()
            };
        });
    } catch (e) { return { error: e.toString() }; }
}

function getHexColorForGCalIndex(index) {
    var colors = { "": "#3a87ad", "1": "#7986cb", "2": "#33b679", "3": "#8e24aa", "4": "#e67c73", "5": "#fbc02d", "6": "#f4511e", "7": "#039be5", "8": "#616161", "9": "#3f51b5", "10": "#32b780", "11": "#d50000" };
    return colors[String(index)] || colors[""];
}

// =========================================================================
// === [V2.2 Stripe 決済基盤統合] クレジットカード登録・消込・自動一括決済 ===
// =========================================================================


/**
 * ==============================================================================
 * 現場管理（配膳リストPDF ＆ 発注集計表）
 * ==============================================================================
 */
function normalizeDateStringForGAS(val) {
    if (!val) return "";
    var date;
    if (val instanceof Date) {
        date = val;
    } else {
        date = new Date(String(val).replace(/-/g, '/'));
    }
    if (isNaN(date.getTime())) {
        return String(val).trim();
    }
    var y = date.getFullYear();
    var m = date.getMonth() + 1;
    var d = date.getDate();
    return y + '/' + (m < 10 ? '0' + m : m) + '/' + (d < 10 ? '0' + d : d);
}

/**
 * パン配布リスト作成ダイアログの表示
 */
function showDistributionDialog() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var teams = [];
  var menuSheet = ss.getSheetByName('メニュー設定');
  if (menuSheet) {
    var lastRow = menuSheet.getLastRow();
    if (lastRow >= 2) {
      var maxCol = menuSheet.getLastColumn();
      var headers = menuSheet.getRange(1, 1, 1, maxCol).getValues()[0];
      var teamColIndex = findColIndex(headers, 'チーム記号');
      var teamNameColIndex = findColIndex(headers, 'チーム名'); // もしあれば
      if (teamColIndex !== -1) {
        var data = menuSheet.getRange(2, 1, lastRow - 1, maxCol).getValues();
        for (var i = 0; i < data.length; i++) {
          var code = String(data[i][teamColIndex]).trim();
          var name = (teamNameColIndex !== -1) ? String(data[i][teamNameColIndex]).trim() : "";
          if (code) {
            teams.push({ code: code, name: name });
          }
        }
      }
    }
  }
  
  var template = HtmlService.createTemplateFromFile('distributionDialog');
  template.teams = teams;
  
  var html = template.evaluate()
      .setTitle('パン配布リストPDF作成')
      .setWidth(450)
      .setHeight(360);
  
  SpreadsheetApp.getUi().showModalDialog(html, 'パン配布リストPDF作成');
}

/**
 * パン配布リストPDFを自動生成するコア関数（月まとめ・改ページ対応）
 * @param {Object} params - { targetMonth, teamCode }
 */


function generateDistributionListPdf(params) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var originalVisibleSheets = [];
  var tempSheets = [];
  
  try {
    var ordersSheet = ss.getSheetByName('Orders');
    var usersSheet = ss.getSheetByName('Users');
    var menuSheet = ss.getSheetByName('メニュー設定');
    
    if (!ordersSheet || !usersSheet) {
      return { success: false, message: "OrdersシートまたはUsersシートが見つかりません。" };
    }
    
    // パラメータ取得とパース（YYYY-MM）
    var targetMonthStr = String(params.targetMonth || "").trim(); // 例: "2026-06"
    if (!targetMonthStr || targetMonthStr.indexOf("-") === -1) {
      return { success: false, message: "対象月が正しく指定されていません。" };
    }
    var parts = targetMonthStr.split("-");
    var year = parseInt(parts[0]);
    var month = parseInt(parts[1]);
    
    var targetTeam = String(params.teamCode || "").trim();
    
    // 対象月のすべての「木曜日」を算出
    var thursdays = [];
    var date = new Date(year, month - 1, 1);
    while (date.getMonth() === month - 1) {
      if (date.getDay() === 4) { // 4 = 木曜日
        thursdays.push(new Date(date));
      }
      date.setDate(date.getDate() + 1);
    }
    
    if (thursdays.length === 0) {
      return { success: false, message: "指定された月に木曜日が見つかりません。" };
    }
    
    // 1. Usersデータのインデックスとマップの作成
    var uLastRow = usersSheet.getLastRow();
    if (uLastRow < 2) {
      return { success: false, message: "Usersシートにデータがありません。" };
    }
    var uHeaders = usersSheet.getRange(1, 1, 1, usersSheet.getLastColumn()).getValues()[0];
    var colUserId = findColIndex(uHeaders, 'UserID');
    var colName = findColIndex(uHeaders, 'Name');
    var colCategory = findColIndex(uHeaders, 'Category');
    var colTeamCode = findColIndex(uHeaders, 'チーム記号');
    var colKana = findColIndex(uHeaders, 'カタカナ氏名') !== -1 ? findColIndex(uHeaders, 'カタカナ氏名') : findColIndex(uHeaders, 'カタカナ名');
    
    var usersData = usersSheet.getRange(2, 1, uLastRow - 1, uHeaders.length).getValues();
    var userMap = {}; // Key: UserID or Name -> { teamCode, category, kanaName, name }
    
    for (var i = 0; i < usersData.length; i++) {
      var uid = String(usersData[i][colUserId]).trim();
      var uname = String(usersData[i][colName]).trim();
      var uTeam = colTeamCode !== -1 ? String(usersData[i][colTeamCode]).trim() : "";
      var uCat = colCategory !== -1 ? String(usersData[i][colCategory]).trim() : "";
      var uKana = colKana !== -1 ? String(usersData[i][colKana]).trim() : "";
      
      var uInfo = { teamCode: uTeam, category: uCat, kanaName: uKana, name: uname };
      if (uid) userMap[uid] = uInfo;
      if (uname) userMap[uname] = uInfo;
    }
    
    // 2. チームごとの「配布リスト形式」と「保存先フォルダID」および「出力ファイル形式」を取得
    var teamFormatMap = {}; // Key: teamCode -> { format, folderId, outFormat }
    if (menuSheet) {
      var mLastRow = menuSheet.getLastRow();
      if (mLastRow >= 2) {
        var mHeaders = menuSheet.getRange(1, 1, 1, menuSheet.getLastColumn()).getValues()[0];
        var colMT = findColIndex(mHeaders, 'チーム記号');
        var colMF = findColIndex(mHeaders, '配布リスト形式');
        var colMFolder = findColIndex(mHeaders, '請求書保存先フォルダID');
        var colMOutFormat = findColIndex(mHeaders, '出力ファイル形式');
        
        var menuData = menuSheet.getRange(2, 1, mLastRow - 1, mHeaders.length).getValues();
        for (var j = 0; j < menuData.length; j++) {
          var tCode = String(menuData[j][colMT]).trim();
          var tFormat = colMF !== -1 ? String(menuData[j][colMF]).trim().toUpperCase() : "A";
          if (!tFormat) tFormat = "A";
          var tFolder = colMFolder !== -1 ? String(menuData[j][colMFolder]).trim() : "";
          var tOutRaw = colMOutFormat !== -1 ? String(menuData[j][colMOutFormat]).trim() : "PDF";
          var tOutFormat = "PDF";
          if (tOutRaw.toUpperCase().indexOf("SPREAD") !== -1 || tOutRaw.indexOf("スプレッド") !== -1) {
            tOutFormat = "SPREADSHEET";
          }
          
          if (tCode) {
            teamFormatMap[tCode] = { format: tFormat, folderId: tFolder, outFormat: tOutFormat };
          }
        }
      }
    }
    
    // 3. Ordersデータの抽出
    var oLastRow = ordersSheet.getLastRow();
    if (oLastRow < 2) {
      return { success: false, message: "Ordersシートにデータがありません。" };
    }
    var oHeaders = ordersSheet.getRange(1, 1, 1, ordersSheet.getLastColumn()).getValues()[0];
    var colOUserId = findColIndex(oHeaders, 'UserID');
    var colOUserName = findColIndex(oHeaders, 'UserName');
    var colOOrderDate = findColIndex(oHeaders, 'OrderDate');
    var colOProductName = findColIndex(oHeaders, 'ProductName');
    var colOQuantity = findColIndex(oHeaders, 'Quantity');
    
    var ordersData = ordersSheet.getRange(2, 1, oLastRow - 1, oHeaders.length).getValues();
    
    // チームごとに注文データを分類
    var teamOrders = {}; // Key: teamCode -> Array of orders
    
    // 月全体の範囲（木〜日のサイクルをカバーするため、指定月の1日から翌月7日まで広めにフィルタ）
    var startCompareLimit = year + '/' + (month < 10 ? '0' + month : month) + '/01';
    var nextMonth = month === 12 ? 1 : month + 1;
    var nextYear = month === 12 ? year + 1 : year;
    var endCompareLimit = nextYear + '/' + (nextMonth < 10 ? '0' + nextMonth : nextMonth) + '/07';
    
    for (var k = 0; k < ordersData.length; k++) {
      var oDateStr = normalizeDateStringForGAS(ordersData[k][colOOrderDate]);
      if (oDateStr >= startCompareLimit && oDateStr <= endCompareLimit) {
        var oUid = String(ordersData[k][colOUserId]).trim();
        var oUname = String(ordersData[k][colOUserName]).trim();
        
        var uInfo = userMap[oUid] || userMap[oUname];
        if (!uInfo) continue;
        
        var oTeam = uInfo.teamCode;
        if (targetTeam && oTeam !== targetTeam) continue;
        
        if (!teamOrders[oTeam]) {
          teamOrders[oTeam] = [];
        }
        
        teamOrders[oTeam].push({
          orderDate: oDateStr,
          userId: oUid,
          userName: uInfo.name,
          category: uInfo.category,
          kanaName: uInfo.kanaName,
          productName: String(ordersData[k][colOProductName]).trim(),
          quantity: parseNumberSafe(ordersData[k][colOQuantity])
        });
      }
    }
    
    var teamCodesWithOrders = Object.keys(teamOrders);
    if (teamCodesWithOrders.length === 0) {
      return { success: false, message: "指定された月の注文データが見つかりませんでした。" };
    }
    
    var generatedPdfs = [];
    
    // 4. 各チームの配布リストを作成してPDFまたはスプレッドシート化
    for (var t = 0; t < teamCodesWithOrders.length; t++) {
      var tCode = teamCodesWithOrders[t];
      var oList = teamOrders[tCode];
      
      var tSettings = teamFormatMap[tCode] || { format: "A", folderId: "", outFormat: "PDF" };
      var format = tSettings.format;
      var folderId = tSettings.folderId || OUTPUT_FOLDER_ID;
      var outFormat = tSettings.outFormat;
      
      var ssId = ss.getId();
      var currentTeamTempSheets = [];
      var isWeeklySplit = (format === "A"); // フォーマットAのみ週サイクル分割
      
      try {
        if (isWeeklySplit) {
          var weekCount = 0;
          
          // 週（木曜日）ごとに別々の一時シートを作成
          thursdays.forEach(function(thursday) {
            var distDateStr = normalizeDateStringForGAS(thursday); // PDF表示用
            var startCompare = normalizeDateStringForGAS(thursday); // 期間開始
            
            var endDateObj = new Date(thursday);
            endDateObj.setDate(thursday.getDate() + 3);
            var endCompare = normalizeDateStringForGAS(endDateObj); // 期間終了
            
            var weeklyOrders = oList.filter(function(item) {
              return item.orderDate >= startCompare && item.orderDate <= endCompare;
            });
            
            if (weeklyOrders.length === 0) return;
            
            weekCount++;
            
            // 一時シートの追加
            var tempSheetName = "Temp_" + tCode + "_W" + weekCount + "_" + Utilities.formatDate(new Date(), "GMT+9", "mmss");
            var tempSheet = ss.insertSheet(tempSheetName);
            tempSheets.push(tempSheet);
            currentTeamTempSheets.push(tempSheet);
            
            // 週次データを書き込んで装飾
            writeAndDecorateSheet(tempSheet, weeklyOrders, format, distDateStr);
          });
          
        } else {
          // 月全体で1枚の一時シートを作成（フォーマットB, C）
          var tempSheetName = "Temp_" + tCode + "_Month_" + Utilities.formatDate(new Date(), "GMT+9", "mmss");
          var tempSheet = ss.insertSheet(tempSheetName);
          tempSheets.push(tempSheet);
          currentTeamTempSheets.push(tempSheet);
          
          // 月次データを書き込んで装飾（日付の集約は行わないため、distDateStrはnullを渡す）
          writeAndDecorateSheet(tempSheet, oList, format, null);
        }
        
        if (currentTeamTempSheets.length === 0) {
          continue;
        }
        
        if (outFormat === "SPREADSHEET") {
          // --- スプレッドシートファイルとして新規作成し保存する ---
          var fileName = "パン配布リスト_" + tCode + "_" + targetMonthStr.replace("-", "");
          var newSS = SpreadsheetApp.create(fileName);
          var newSSFile = DriveApp.getFileById(newSS.getId());
          
          // 保存先フォルダに移動
          var folder = DriveApp.getFolderById(folderId);
          folder.addFile(newSSFile);
          try {
            DriveApp.getRootFolder().removeFile(newSSFile);
          } catch(e) {}
          
          // 一時シートをコピー
          currentTeamTempSheets.forEach(function(tempSheet, index) {
            var copiedSheet = tempSheet.copyTo(newSS);
            if (isWeeklySplit) {
              copiedSheet.setName("週_" + (index + 1));
            } else {
              copiedSheet.setName("配布リスト");
            }
          });
          
          // デフォルトで用意される「シート1」を削除
          var defaultSheet = newSS.getSheetByName("シート1") || newSS.getSheetByName("Sheet1");
          if (defaultSheet) {
            newSS.deleteSheet(defaultSheet);
          }
          
          // 共有リンク設定
          newSSFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          
          generatedPdfs.push({ teamCode: tCode, url: newSS.getUrl(), isSpreadsheet: true });
          
        } else {
          // --- PDFとしてエクスポート ---
          // 既存の通常シートを非表示にする
          var allSheets = ss.getSheets();
          allSheets.forEach(function(s) {
            if (s.getName().indexOf("Temp_") !== 0 && !s.isSheetHidden()) {
              originalVisibleSheets.push(s);
            }
          });
          
          originalVisibleSheets.forEach(function(s) {
            s.hideSheet();
          });
          
          // 他のチームの一時シートを非表示、このチームの一時シートだけを表示
          tempSheets.forEach(function(s) {
            if (currentTeamTempSheets.indexOf(s) === -1) {
              s.hideSheet();
            } else {
              s.showSheet();
            }
          });
          
          var folder = DriveApp.getFolderById(folderId);
          var pdfUrl = "https://docs.google.com/spreadsheets/d/" + ssId + "/export?" + 
              "exportFormat=pdf&format=pdf" + 
              "&size=A4" + 
              "&portrait=true" + 
              "&fitw=true" + 
              "&gridlines=false" + 
              "&printtitle=false&sheetnames=false&fzr=true";
              
          var response = UrlFetchApp.fetch(pdfUrl, {
            headers: {
              'Authorization': 'Bearer ' +  ScriptApp.getOAuthToken(),
            },
            muteHttpExceptions: true
          });
          
          if (response.getResponseCode() === 200) {
            var pdfName = "パン配布リスト_" + tCode + "_" + targetMonthStr.replace("-", "") + ".pdf";
            var blob = response.getBlob().setName(pdfName);
            var file = folder.createFile(blob);
            file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
            
            generatedPdfs.push({ teamCode: tCode, url: file.getUrl(), isSpreadsheet: false });
          } else {
            throw new Error("PDF出力のHTTP通信エラー: " + response.getResponseCode());
          }
        }
        
      } finally {
        originalVisibleSheets.forEach(function(s) {
          try { s.showSheet(); } catch(e){}
        });
        originalVisibleSheets = [];
        
        currentTeamTempSheets.forEach(function(s) {
          try { ss.deleteSheet(s); } catch(e){}
        });
      }
    }
    
    if (generatedPdfs.length === 1) {
      return { success: true, pdfUrl: generatedPdfs[0].url, isSpreadsheet: generatedPdfs[0].isSpreadsheet };
    } else {
      var htmlLinks = "<div style='text-align: left; margin-top: 10px;'>";
      generatedPdfs.forEach(function(item) {
        var label = item.isSpreadsheet ? "スプレッドシートを表示" : "PDFを表示";
        htmlLinks += "<div style='margin-bottom: 8px;'>・" + item.teamCode + "チーム: <a href='" + item.url + "' target='_blank' style='color:#2b4b6f; font-weight:600;'>" + label + "</a></div>";
      });
      htmlLinks += "</div>";
      return { success: true, pdfUrl: "", htmlLinks: htmlLinks };
    }
    
  } catch (e) {
    console.error("generateDistributionListPdf error:", e);
    return { success: false, message: e.toString() };
  }
}

/**
 * データを書き込み、書式設定・セルマージを適用する共通ヘルパー関数
 */
function writeAndDecorateSheet(sheet, ordersList, format, distDateStr) {
  var displayHeaders = [];
  var writeData = [];
  
  if (format === "A" || format === "B") {
    displayHeaders = ['日付', 'カテゴリー', 'UserName', 'ProductName', '個数'];
  } else if (format === "C") {
    displayHeaders = ['日付', 'カテゴリー', 'ProductName', 'UserName', '個数'];
  }
  
  if (format === "A") {
    var aggregateMap = {};
    ordersList.forEach(function(item) {
      var aggKey = item.userId + "_" + item.productName;
      if (!aggregateMap[aggKey]) {
        aggregateMap[aggKey] = {
          date: distDateStr, // 配布日の日付
          category: item.category,
          userName: item.userName,
          kanaName: item.kanaName,
          productName: item.productName,
          quantity: 0
        };
      }
      aggregateMap[aggKey].quantity += item.quantity;
    });
    
    var aggList = Object.keys(aggregateMap).map(function(k) { return aggregateMap[k]; });
    
    aggList.sort(function(a, b) {
      var catA = getCategorySortKey(a.category);
      var catB = getCategorySortKey(b.category);
      if (catA !== catB) return catA - catB;
      
      var nameA = a.kanaName || a.userName;
      var nameB = b.kanaName || b.userName;
      if (nameA !== nameB) return nameA.localeCompare(nameB, 'ja');
      
      return a.productName.localeCompare(b.productName, 'ja');
    });
    
    aggList.forEach(function(item) {
      writeData.push([item.date, item.category, item.userName, item.productName, item.quantity]);
    });
    
  } else if (format === "B") {
    var aggregateMap = {};
    ordersList.forEach(function(item) {
      var aggKey = item.orderDate + "_" + item.userId + "_" + item.productName;
      if (!aggregateMap[aggKey]) {
        aggregateMap[aggKey] = {
          date: item.orderDate,
          category: item.category,
          userName: item.userName,
          kanaName: item.kanaName,
          productName: item.productName,
          quantity: 0
        };
      }
      aggregateMap[aggKey].quantity += item.quantity;
    });
    
    var aggList = Object.keys(aggregateMap).map(function(k) { return aggregateMap[k]; });
    
    aggList.sort(function(a, b) {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      
      var catA = getCategorySortKey(a.category);
      var catB = getCategorySortKey(b.category);
      if (catA !== catB) return catA - catB;
      
      var nameA = a.kanaName || a.userName;
      var nameB = b.kanaName || b.userName;
      if (nameA !== nameB) return nameA.localeCompare(nameB, 'ja');
      
      return a.productName.localeCompare(b.productName, 'ja');
    });
    
    aggList.forEach(function(item) {
      writeData.push([item.date, item.category, item.userName, item.productName, item.quantity]);
    });
    
  } else if (format === "C") {
    var aggregateMap = {};
    ordersList.forEach(function(item) {
      var aggKey = item.orderDate + "_" + item.category + "_" + item.productName + "_" + item.userId;
      if (!aggregateMap[aggKey]) {
        aggregateMap[aggKey] = {
          date: item.orderDate,
          category: item.category,
          userName: item.userName,
          kanaName: item.kanaName,
          productName: item.productName,
          quantity: 0
        };
      }
      aggregateMap[aggKey].quantity += item.quantity;
    });
    
    var aggList = Object.keys(aggregateMap).map(function(k) { return aggregateMap[k]; });
    
    aggList.sort(function(a, b) {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      
      var catA = getCategorySortKey(a.category);
      var catB = getCategorySortKey(b.category);
      if (catA !== catB) return catA - catB;
      
      if (a.productName !== b.productName) return a.productName.localeCompare(b.productName, 'ja');
      
      var nameA = a.kanaName || a.userName;
      var nameB = b.kanaName || b.userName;
      return nameA.localeCompare(nameB, 'ja');
    });
    
    aggList.forEach(function(item) {
      writeData.push([item.date, item.category, item.productName, item.userName, item.quantity]);
    });
  }
  
  // 書き込み
  sheet.appendRow(displayHeaders);
  if (writeData.length > 0) {
    sheet.getRange(2, 1, writeData.length, displayHeaders.length).setValues(writeData);
  }
  
  var lastRow = sheet.getLastRow();
  
  // --- 装飾 ---
  if (lastRow >= 1) {
    sheet.setFrozenRows(1);
    
    var allRange = sheet.getRange(1, 1, lastRow, displayHeaders.length);
    allRange.setFontFamily("Arial");
    allRange.setFontSize(10);
    allRange.setVerticalAlignment("middle");
    allRange.setWrap(true);
    
    var headerRange = sheet.getRange(1, 1, 1, displayHeaders.length);
    headerRange.setBackground("#2c3e50");
    headerRange.setFontColor("#ffffff");
    headerRange.setFontWeight("bold");
    headerRange.setHorizontalAlignment("center");
    
    if (lastRow >= 2) {
      sheet.getRange(2, 1, lastRow - 1, 2).setHorizontalAlignment("center");
      
      if (format === "A" || format === "B") {
        sheet.getRange(2, 3, lastRow - 1, 1).setHorizontalAlignment("center");
        sheet.getRange(2, 4, lastRow - 1, 1).setHorizontalAlignment("left");
        sheet.getRange(2, 5, lastRow - 1, 1).setHorizontalAlignment("center");
      } else if (format === "C") {
        sheet.getRange(2, 3, lastRow - 1, 1).setHorizontalAlignment("left");
        sheet.getRange(2, 4, lastRow - 1, 1).setHorizontalAlignment("center");
        sheet.getRange(2, 5, lastRow - 1, 1).setHorizontalAlignment("center");
      }
      
      var dataRange = sheet.getRange(2, 1, lastRow - 1, displayHeaders.length);
      dataRange.setBorder(true, true, true, true, true, true, "#cccccc", SpreadsheetApp.BorderStyle.SOLID);
      headerRange.setBorder(true, true, true, true, true, true, "#ffffff", SpreadsheetApp.BorderStyle.SOLID);
      
      // 安全なメモリベースのセル結合（マージ）
      applyMergeRanges(sheet, writeData);
    }
    
    sheet.autoResizeColumns(1, displayHeaders.length);
    for (var c = 1; c <= displayHeaders.length; c++) {
      var currentWidth = sheet.getColumnWidth(c);
      sheet.setColumnWidth(c, currentWidth + 35);
    }
  }
}

/**
 * 学年文字列からソート順数値を抽出するヘルパー関数
 */
function getCategorySortKey(catStr) {
  if (!catStr) return 999;
  var match = String(catStr).replace(/[２-９]/g, function (s) {
    return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
  }).replace(/１/g, "1").match(/\d+/);
  return match ? parseInt(match[0]) : 999;
}

/**
 * メモリベースのセル結合（マージ）実行ヘルパー関数
 */
function applyMergeRanges(sheet, writeData) {
  var lastRow = writeData.length + 1;
  if (lastRow < 2) return;
  
  // A列(日付)のマージ範囲計算
  var aRanges = [];
  var start = 0;
  for (var i = 1; i < writeData.length; i++) {
    if (writeData[i][0] !== writeData[start][0]) {
      if (i - start > 1) {
        aRanges.push({row: start + 2, numRows: i - start});
      }
      start = i;
    }
  }
  if (writeData.length - start > 1) {
    aRanges.push({row: start + 2, numRows: writeData.length - start});
  }
  
  // B列(カテゴリー)のマージ範囲計算 (A列が一致かつB列が一致)
  var bRanges = [];
  start = 0;
  for (var i = 1; i < writeData.length; i++) {
    if (writeData[i][0] !== writeData[start][0] || writeData[i][1] !== writeData[start][1]) {
      if (i - start > 1) {
        bRanges.push({row: start + 2, numRows: i - start});
      }
      start = i;
    }
  }
  if (writeData.length - start > 1) {
    bRanges.push({row: start + 2, numRows: writeData.length - start});
  }
  
  // C列(UserName/ProductName)のマージ範囲計算 (A列, B列が一致かつC列が一致)
  var cRanges = [];
  start = 0;
  for (var i = 1; i < writeData.length; i++) {
    if (writeData[i][0] !== writeData[start][0] || writeData[i][1] !== writeData[start][1] || writeData[i][2] !== writeData[start][2]) {
      if (i - start > 1) {
        cRanges.push({row: start + 2, numRows: i - start});
      }
      start = i;
    }
  }
  if (writeData.length - start > 1) {
    cRanges.push({row: start + 2, numRows: writeData.length - start});
  }
  
  // マージをスプレッドシートに適用
  aRanges.forEach(function(r) {
    sheet.getRange(r.row, 1, r.numRows, 1).merge().setVerticalAlignment("middle").setHorizontalAlignment("center");
  });
  bRanges.forEach(function(r) {
    sheet.getRange(r.row, 2, r.numRows, 1).merge().setVerticalAlignment("middle").setHorizontalAlignment("center");
  });
  cRanges.forEach(function(r) {
    sheet.getRange(r.row, 3, r.numRows, 1).merge().setVerticalAlignment("middle").setHorizontalAlignment("center");
  });
}

/**
 * パン発注リスト作成ダイアログの表示
 */

function showOrderAggregationDialog() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var teams = [];
  var menuSheet = ss.getSheetByName('メニュー設定');
  if (menuSheet) {
    var lastRow = menuSheet.getLastRow();
    if (lastRow >= 2) {
      var maxCol = menuSheet.getLastColumn();
      var headers = menuSheet.getRange(1, 1, 1, maxCol).getValues()[0];
      var teamColIndex = findColIndex(headers, 'チーム記号');
      var teamNameColIndex = findColIndex(headers, 'チーム名');
      if (teamColIndex !== -1) {
        var data = menuSheet.getRange(2, 1, lastRow - 1, maxCol).getValues();
        for (var i = 0; i < data.length; i++) {
          var code = String(data[i][teamColIndex]).trim();
          var name = (teamNameColIndex !== -1) ? String(data[i][teamNameColIndex]).trim() : "";
          if (code) {
            teams.push({ code: code, name: name });
          }
        }
      }
    }
  }
  
  var template = HtmlService.createTemplateFromFile('orderDialog');
  template.teams = teams;
  
  var html = template.evaluate()
      .setTitle('パン発注リスト作成')
      .setWidth(450)
      .setHeight(360);
  
  SpreadsheetApp.getUi().showModalDialog(html, 'パン発注リスト作成');
}

/**
 * パン発注リスト（スプレッドシート）を自動生成するコア関数
 * @param {Object} params - { targetMonth, teamCode }
 */
function generateOrderAggregationSheet(params) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tempSheet = null;
  
  try {
    var ordersSheet = ss.getSheetByName('Orders');
    var usersSheet = ss.getSheetByName('Users');
    var menuSheet = ss.getSheetByName('メニュー設定');
    
    if (!ordersSheet || !usersSheet) {
      return { success: false, message: "OrdersシートまたはUsersシートが見つかりません。" };
    }
    
    // パラメータ取得とパース（YYYY-MM）
    var targetMonthStr = String(params.targetMonth || "").trim(); // 例: "2026-06"
    if (!targetMonthStr || targetMonthStr.indexOf("-") === -1) {
      return { success: false, message: "対象月が正しく指定されていません。" };
    }
    var parts = targetMonthStr.split("-");
    var year = parseInt(parts[0]);
    var month = parseInt(parts[1]);
    
    var targetTeam = String(params.teamCode || "").trim();
    if (!targetTeam) {
      return { success: false, message: "対象チームが指定されていません。" };
    }
    
    // 1. チームの設定から「発注リスト曜日グループ」と「保存先フォルダID」を取得
    var groupSetting = "";
    var folderId = "";
    if (menuSheet) {
      var mLastRow = menuSheet.getLastRow();
      if (mLastRow >= 2) {
        var mHeaders = menuSheet.getRange(1, 1, 1, menuSheet.getLastColumn()).getValues()[0];
        var colMT = findColIndex(mHeaders, 'チーム記号');
        var colMGroup = findColIndex(mHeaders, '発注リスト曜日グループ');
        var colMFolder = findColIndex(mHeaders, '請求書保存先フォルダID');
        
        var menuData = menuSheet.getRange(2, 1, mLastRow - 1, mHeaders.length).getValues();
        for (var j = 0; j < menuData.length; j++) {
          var tCode = String(menuData[j][colMT]).trim();
          if (tCode === targetTeam) {
            groupSetting = colMGroup !== -1 ? String(menuData[j][colMGroup]).trim() : "";
            folderId = colMFolder !== -1 ? String(menuData[j][colMFolder]).trim() : "";
            break;
          }
        }
      }
    }
    
    if (!groupSetting) {
      return { success: false, message: "対象チームの設定に「発注リスト曜日グループ」が登録されていないか、空欄です。" };
    }
    
    // 曜日グループのパース (例: "火水,木金" -> [[2, 3], [4, 5]])
    var WEEKDAY_MAP = { '日': 0, '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6 };
    var rawGroups = groupSetting.split(",");
    var parsedGroups = [];
    for (var g = 0; g < rawGroups.length; g++) {
      var rawGroup = rawGroups[g].trim();
      if (!rawGroup) continue;
      var groupDays = [];
      for (var c = 0; c < rawGroup.length; c++) {
        var char = rawGroup.charAt(c);
        if (WEEKDAY_MAP[char] !== undefined) {
          groupDays.push(WEEKDAY_MAP[char]);
        }
      }
      if (groupDays.length > 0) {
        parsedGroups.push(groupDays);
      }
    }
    
    if (parsedGroups.length === 0) {
      return { success: false, message: "「発注リスト曜日グループ」を正しくパースできませんでした。入力例: 火水,木金" };
    }
    
    // 2. 指定月内の該当曜日を週ごとに算出
    function getMondayOfDate(d) {
      var day = d.getDay();
      var diff = d.getDate() - (day === 0 ? 6 : day - 1);
      var mon = new Date(d.getFullYear(), d.getMonth(), diff);
      var y = mon.getFullYear();
      var m = ("0" + (mon.getMonth() + 1)).slice(-2);
      var dd = ("0" + mon.getDate()).slice(-2);
      return y + "-" + m + "-" + dd;
    }
    
    var weeks = {};
    var tempDate = new Date(year, month - 1, 1);
    var daysInMonth = [];
    while (tempDate.getMonth() === month - 1) {
      daysInMonth.push(new Date(tempDate));
      tempDate.setDate(tempDate.getDate() + 1);
    }
    
    daysInMonth.forEach(function(d) {
      var day = d.getDay();
      for (var gIdx = 0; gIdx < parsedGroups.length; gIdx++) {
        var groupDays = parsedGroups[gIdx];
        if (groupDays.indexOf(day) !== -1) {
          var mondayStr = getMondayOfDate(d);
          if (!weeks[mondayStr]) {
            var emptyGroups = [];
            for (var i = 0; i < parsedGroups.length; i++) {
              emptyGroups.push([]);
            }
            weeks[mondayStr] = { mondayStr: mondayStr, groups: emptyGroups };
          }
          weeks[mondayStr].groups[gIdx].push(d);
          break;
        }
      }
    });
    
    var sortedWeeks = Object.keys(weeks).sort().map(function(key) {
      return weeks[key];
    });
    
    // 列構成の定義
    var columns = [];
    sortedWeeks.forEach(function(week) {
      week.groups.forEach(function(groupDates, gIdx) {
        if (groupDates.length === 0) return;
        
        groupDates.sort(function(a, b) { return a.getTime() - b.getTime(); });
        
        var startCol = columns.length + 2; // A列(1)の後ろから始まるため + 2
        groupDates.forEach(function(d) {
          var label = d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate();
          columns.push({ type: "date", dateStr: label, label: label });
        });
        var endCol = columns.length + 1;
        
        columns.push({ type: "sum", label: "合計", startColIdx: startCol, endColIdx: endCol });
      });
    });
    
    if (columns.length === 0) {
      return { success: false, message: "指定された曜日ペアに該当する日付が今月内に見つかりません。" };
    }
    
    // 3. 対象チームのユーザーリストの抽出
    var uLastRow = usersSheet.getLastRow();
    if (uLastRow < 2) {
      return { success: false, message: "Usersシートにデータがありません。" };
    }
    var uHeaders = usersSheet.getRange(1, 1, 1, usersSheet.getLastColumn()).getValues()[0];
    var colUserId = findColIndex(uHeaders, 'UserID');
    var colName = findColIndex(uHeaders, 'Name');
    var colTeamCode = findColIndex(uHeaders, 'チーム記号');
    
    var usersData = usersSheet.getRange(2, 1, uLastRow - 1, uHeaders.length).getValues();
    var targetUserIds = {};
    for (var i = 0; i < usersData.length; i++) {
      var uTeam = colTeamCode !== -1 ? String(usersData[i][colTeamCode]).trim() : "";
      if (uTeam === targetTeam) {
        var uid = String(usersData[i][colUserId]).trim();
        var uname = String(usersData[i][colName]).trim();
        if (uid) targetUserIds[uid] = true;
        if (uname) targetUserIds[uname] = true;
      }
    }
    
    // 4. 注文データの抽出と集計
    var oLastRow = ordersSheet.getLastRow();
    if (oLastRow < 2) {
      return { success: false, message: "Ordersシートに注文データがありません。" };
    }
    var oHeaders = ordersSheet.getRange(1, 1, 1, ordersSheet.getLastColumn()).getValues()[0];
    var colOUserId = findColIndex(oHeaders, 'UserID');
    var colOUserName = findColIndex(oHeaders, 'UserName');
    var colOOrderDate = findColIndex(oHeaders, 'OrderDate');
    var colOProductName = findColIndex(oHeaders, 'ProductName');
    var colOQuantity = findColIndex(oHeaders, 'Quantity');
    
    var ordersData = ordersSheet.getRange(2, 1, oLastRow - 1, oHeaders.length).getValues();
    var productSet = {};
    var orderMap = {};
    
    for (var k = 0; k < ordersData.length; k++) {
      var oUid = String(ordersData[k][colOUserId]).trim();
      var oUname = String(ordersData[k][colOUserName]).trim();
      if (!targetUserIds[oUid] && !targetUserIds[oUname]) continue;
      
      var oDateStr = normalizeDateStringForGAS(ordersData[k][colOOrderDate]);
      var dateParts = oDateStr.split("/");
      if (dateParts.length < 3) continue;
      var oYear = parseInt(dateParts[0]);
      var oMonth = parseInt(dateParts[1]);
      if (oYear !== year || oMonth !== month) continue;
      
      var pName = String(ordersData[k][colOProductName]).trim();
      var qty = parseInt(ordersData[k][colOQuantity]);
      if (isNaN(qty) || qty <= 0) continue;
      
      productSet[pName] = true;
      if (!orderMap[pName]) {
        orderMap[pName] = {};
      }
      var cleanDateStr = oYear + "/" + oMonth + "/" + parseInt(dateParts[2]);
      if (!orderMap[pName][cleanDateStr]) {
        orderMap[pName][cleanDateStr] = 0;
      }
      orderMap[pName][cleanDateStr] += qty;
    }
    
    var productList = Object.keys(productSet).sort();
    if (productList.length === 0) {
      return { success: false, message: "対象チームの注文データが今月内に見つかりません。" };
    }
    
    // 5. データ配列の作成
    var rowCount = productList.length + 2;
    var colCount = columns.length + 1;
    var values = [];
    
    var headerRow = ["ProductName"];
    columns.forEach(function(col) {
      headerRow.push(col.label);
    });
    values.push(headerRow);
    
    productList.forEach(function(pName, pIdx) {
      var rowIdx = pIdx + 2;
      var row = [pName];
      columns.forEach(function(col) {
        if (col.type === "date") {
          var qty = orderMap[pName][col.dateStr] || "";
          row.push(qty);
        } else if (col.type === "sum") {
          var formula = "=SUM(" + getColLetter(col.startColIdx) + rowIdx + ":" + getColLetter(col.endColIdx) + rowIdx + ")";
          row.push(formula);
        }
      });
      values.push(row);
    });
    
    var totalRow = ["総計"];
    columns.forEach(function(col, cIdx) {
      var colLetter = getColLetter(cIdx + 2);
      var formula = "=SUM(" + colLetter + "2:" + colLetter + (productList.length + 1) + ")";
      totalRow.push(formula);
    });
    values.push(totalRow);
    
    // 6. 一時シートへの書き込みと装飾
    tempSheet = ss.insertSheet("temp_order_sheet");
    var range = tempSheet.getRange(1, 1, rowCount, colCount);
    range.setValues(values);
    
    // 全体装飾
    var allRange = tempSheet.getRange(1, 1, rowCount, colCount);
    allRange.setFontFamily("Inter");
    allRange.setFontSize(10);
    allRange.setBorder(true, true, true, true, true, true, "#e2e8f0", SpreadsheetApp.BorderStyle.SOLID);
    
    // ヘッダー行装飾
    var headerRange = tempSheet.getRange(1, 1, 1, colCount);
    headerRange.setFontWeight("bold");
    headerRange.setBackgroundColor("#f1f5f9");
    headerRange.setHorizontalAlignment("center");
    headerRange.setVerticalAlignment("middle");
    
    // データセル
    var dataRange = tempSheet.getRange(2, 2, rowCount - 1, colCount - 1);
    dataRange.setHorizontalAlignment("right");
    
    var nameRange = tempSheet.getRange(2, 1, rowCount - 1, 1);
    nameRange.setHorizontalAlignment("left");
    nameRange.setFontWeight("bold");
    
    // 合計列装飾
    columns.forEach(function(col, cIdx) {
      if (col.type === "sum") {
        var colNum = cIdx + 2;
        var sumColRange = tempSheet.getRange(1, colNum, rowCount, 1);
        sumColRange.setBackgroundColor("#fce5cd"); // 薄いオレンジ
        sumColRange.setFontWeight("bold");
      }
    });
    
    // 総計行装飾
    var totalRange = tempSheet.getRange(rowCount, 1, 1, colCount);
    totalRange.setFontWeight("bold");
    totalRange.setBackgroundColor("#f8fafc");
    totalRange.setBorder(true, null, true, null, null, null, "#1e293b", SpreadsheetApp.BorderStyle.DOUBLE);
    
    // 列幅調整
    tempSheet.autoResizeColumn(1);
    var currentWidth = tempSheet.getColumnWidth(1);
    tempSheet.setColumnWidth(1, Math.max(currentWidth + 20, 150));
    for (var c = 2; c <= colCount; c++) {
      tempSheet.setColumnWidth(c, 85);
    }
    
    // 7. 新規スプレッドシートへのコピーと保存先への移動
    var fileName = "パン発注リスト_" + targetTeam + "_" + targetMonthStr.replace("-", "");
    var newSS = SpreadsheetApp.create(fileName);
    var copiedSheet = tempSheet.copyTo(newSS);
    
    var sheets = newSS.getSheets();
    sheets.forEach(function(sh) {
      if (sh.getName() !== copiedSheet.getName()) {
        newSS.deleteSheet(sh);
      }
    });
    copiedSheet.setName("発注リスト_" + year + "年" + month + "月");
    copiedSheet.setHiddenGridlines(false);
    
    if (folderId) {
      try {
        var file = DriveApp.getFileById(newSS.getId());
        var folder = DriveApp.getFolderById(folderId);
        folder.addFile(file);
        DriveApp.getRootFolder().removeFile(file);
      } catch (err) {
        console.error("フォルダ移動エラー: " + err.message);
      }
    }
    
    try {
      var file = DriveApp.getFileById(newSS.getId());
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (err) {
      console.error("共有設定エラー: " + err.message);
    }
    
    return { success: true, sheetUrl: newSS.getUrl() };
    
  } catch (error) {
    return { success: false, message: error.message };
  } finally {
    if (tempSheet) {
      try {
        ss.deleteSheet(tempSheet);
      } catch (e) {
        console.error("一時シート削除エラー: " + e.message);
      }
    }
  }
}

/**
 * 列インデックスをアルファベット表記に変換するヘルパー関数
 */
function getColLetter(colNum) {
  var temp, letter = '';
  while (colNum > 0) {
    temp = (colNum - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    colNum = (colNum - temp - 1) / 26;
  }
  return letter;
}


/**
 * 一括カード決済の予約（タイマー実行）をセットする
 */
/**
 * 一括カード決済の予約（タイマー実行）をセットする（マルチ予約対応）
 */

/**
 * ==============================================================================
 * LINE一斉・予約配信
 * ==============================================================================
 */
function sendFreeMessage() {
    var ui = SpreadsheetApp.getUi();
    var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    
    // 1. Usersシートから送信対象者を抽出
    var usersSheet = spreadsheet.getSheetByName("Users");
    if (!usersSheet) {
        ui.alert('エラー', 'Usersシートが見つかりません。', ui.ButtonSet.OK);
        return;
    }
    
    var lastRow = usersSheet.getLastRow();
    if (lastRow < 2) {
        ui.alert('データがありません。');
        return;
    }
    
    var maxCol = usersSheet.getLastColumn();
    var headers = usersSheet.getRange(1, 1, 1, maxCol).getValues()[0];
    var data = usersSheet.getRange(2, 1, lastRow - 1, maxCol).getValues();
    
    var colLineId = findColIndex(headers, 'LINE_ID');
    if (colLineId === -1) colLineId = findColIndex(headers, 'LINE ID');
    var colName = findColIndex(headers, 'Name');
    var colTeamCode = findColIndex(headers, 'チーム記号');
    var colTeamName = findColIndex(headers, 'チーム名');
    var colPeriod = findColIndex(headers, '時期');
    
    // 「個別送信対象」列を探す（U列付近）
    var colSelect = findColIndex(headers, '個別送信対象');
    if (colSelect === -1) {
        ui.alert('エラー', 'Usersシートに「個別送信対象」列が見つかりません。列名を確認してください。', ui.ButtonSet.OK);
        return;
    }
    
    // チェックが入っているユーザーを抽出
    var targets = [];
    for (var i = 0; i < data.length; i++) {
        var isChecked = data[i][colSelect];
        // TRUE またはチェックボックスのチェックが入っている状態
        if (isChecked === true || isChecked === "TRUE" || isChecked === "✅") {
            targets.push({
                rowIdx: i + 2, // スプレッドシート上の行番号 (1-indexed, ヘッダー除外で+2)
                lineId: String(data[i][colLineId] || "").trim(),
                name: String(data[i][colName] || "").trim(),
                teamCode: String(data[i][colTeamCode] || "").trim(),
                teamName: String(data[i][colTeamName] || "").trim(),
                period: String(data[i][colPeriod] || "").trim()
            });
        }
    }
    
    if (targets.length === 0) {
        ui.alert('通知', '送信対象者がいません。Usersシートの「個別送信対象」列にチェックを入れてから実行してください。', ui.ButtonSet.OK);
        return;
    }
    
    // 2. メッセージテンプレートシートから「FREE」の文章を取得
    var templateSheet = spreadsheet.getSheetByName("メッセージテンプレート");
    var freeMessageTemplate = "";
    if (templateSheet) {
        var tData = templateSheet.getDataRange().getValues();
        var tHeaders = tData[0];
        var colTCode = findColIndex(tHeaders, 'チーム記号');
        var colMsg = findColIndex(tHeaders, '案内メッセージ');
        
        if (colTCode !== -1 && colMsg !== -1) {
            for (var j = 1; j < tData.length; j++) {
                var code = String(tData[j][colTCode] || "").trim().toUpperCase();
                if (code === "FREE") {
                    freeMessageTemplate = String(tData[j][colMsg] || "").trim();
                    break;
                }
            }
        }
    }
    
    var messageToSend = "";
    // FREEテンプレートがある場合、確認画面を表示
    if (freeMessageTemplate) {
        var confirmMsg = '「メッセージテンプレート」の【FREE】に登録されている以下の文章を、チェックが入っている ' + targets.length + ' 名に送信します。よろしいですか？\n\n' +
                         '--------------------------------------------------\n' +
                         freeMessageTemplate + '\n' +
                         '--------------------------------------------------';
        var response = ui.alert('送信メッセージの確認', confirmMsg, ui.ButtonSet.YES_NO);
        if (response !== ui.Button.YES) return;
        messageToSend = freeMessageTemplate;
    } else {
        // FREEテンプレートがない場合は、その場で手入力を求める (フォールバック)
        var promptRes = ui.prompt('お知らせメッセージ送信（FREE未設定）', 
            'メッセージテンプレートの【FREE】が空欄です。代わりに送信したいメッセージ内容を以下に入力してください。', 
            ui.ButtonSet.OK_CANCEL);
        if (promptRes.getSelectedButton() !== ui.Button.OK) return;
        messageToSend = promptRes.getResponseText().trim();
    }
    
    if (!messageToSend) {
        ui.alert('エラー', '送信するメッセージが空欄のため、処理を中止しました。', ui.ButtonSet.OK);
        return;
    }
    
    // LINEのチャンネルアクセストークン取得
    var channelToken = PropertiesService.getScriptProperties().getProperty('CHANNEL_ACCESS_TOKEN');
    if (!channelToken) {
        ui.alert('エラー', 'チャンネルアクセストークンが設定されていません。', ui.ButtonSet.OK);
        return;
    }
    
    // 3. メッセージ送信処理
    var sendCount = 0;
    var errorCount = 0;
    var pushUrl = "https://api.line.me/v2/bot/message/push";
    
    for (var k = 0; k < targets.length; k++) {
        var target = targets[k];
        var rawLineId = target.lineId || "";
        
        // カンマ（半角・全角）で分割し、トリム＆"U"から始まる有効なIDのみ抽出
        var ids = rawLineId.replace(/，/g, ",").split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s !== "" && s.indexOf("U") === 0; });
        
        // 【パターンB】2つ以上ある場合は1番目（子）をスキップし2番目以降（親）に送信。1つの場合は本人のみ。
        var recipientIds = [];
        if (ids.length > 1) {
            recipientIds = ids.slice(1);
        } else if (ids.length === 1) {
            recipientIds = ids;
        }

        if (recipientIds.length === 0) {
            errorCount++;
            console.warn("有効なLINE IDが見つかりません (行 " + target.rowIdx + "): " + rawLineId);
            continue;
        }
        
        // 個人に合わせたプレースホルダー置換
        var periodStr = target.period;
        if (periodStr && !periodStr.endsWith("分") && !periodStr.endsWith("月分")) {
            periodStr = periodStr + "月分";
        }
        var customizedText = messageToSend
            .replace(/{Name}/g, target.name)
            .replace(/{TeamName}/g, target.teamName)
            .replace(/{Period}/g, periodStr || "当月分")
            .replace(/{PeriodStr}/g, periodStr || "当月分");

        var userSuccess = false;
        
        // 対象のLINE IDへ1件ずつ送信
        recipientIds.forEach(function(targetId) {
            var payload = {
                to: targetId,
                messages: [{
                    type: "text",
                    text: customizedText
                }]
            };
            
            var options = {
                method: "post",
                headers: { "Authorization": "Bearer " + channelToken },
                contentType: "application/json",
                payload: JSON.stringify(payload),
                muteHttpExceptions: true
            };
            
            var res = UrlFetchApp.fetch(pushUrl, options);
            if (res.getResponseCode() === 200) {
                sendCount++;
                userSuccess = true;
            } else {
                errorCount++;
                console.error("LINE送信失敗 (行 " + target.rowIdx + ", ID: " + targetId + "): " + res.getContentText());
            }
            Utilities.sleep(100); // 連続送信用の短い待機
        });
        
        // 少なくとも1件送信が成功した場合はチェックボックスをクリア (false) する
        if (userSuccess) {
            usersSheet.getRange(target.rowIdx, colSelect + 1).setValue(false);
        }
    }
    
    var resultMsg = sendCount + " 件のメッセージ送信が完了しました！";
    if (errorCount > 0) {
        resultMsg += "\n（内、" + errorCount + " 件は宛先不明などの原因で送信できませんでした）";
    }
    ui.alert('送信完了', resultMsg, ui.ButtonSet.OK);
}


/**
 * 現在のカード決済予約およびLINE送信予約の状況を確認する（マルチ表示対応）
 */

/**
 * ==============================================================================
 * 動作検証用テスト関数
 * ==============================================================================
 */
function testPointMilestoneAndReward() {
    console.log("Starting testPointMilestoneAndReward...");
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    getOrCreatePayPayStockSheet(ss);
    console.log("PayPay stock sheet verified.");
}

/**
 * LINE受信箱の内容を走査し、Usersシートの該当選手へLINE IDを一括同期する
 */
function syncInboxLineIdsToUsersSheet() {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var inboxSheet = ss.getSheetByName('LINE受信箱');
    var usersSheet = ss.getSheetByName('Users');

    if (!inboxSheet || !usersSheet) {
        SpreadsheetApp.getUi().alert('エラー', 'LINE受信箱またはUsersシートが見つかりません。', SpreadsheetApp.getUi().ButtonSet.OK);
        return;
    }

    var inboxLastRow = inboxSheet.getLastRow();
    if (inboxLastRow < 2) {
        SpreadsheetApp.getUi().alert('情報', 'LINE受信箱にデータがありません。', SpreadsheetApp.getUi().ButtonSet.OK);
        return;
    }

    var uLastRow = usersSheet.getLastRow();
    var uHeaders = usersSheet.getRange(1, 1, 1, usersSheet.getLastColumn()).getValues()[0];
    var colName = findColIndex(uHeaders, 'Name');
    if (colName === -1) colName = findColIndex(uHeaders, '氏名');
    if (colName === -1) colName = findColIndex(uHeaders, '名前');
    if (colName === -1) colName = findColIndex(uHeaders, '選手名');
    if (colName === -1) colName = findColIndex(uHeaders, 'お名前');

    var colKana = findColIndex(uHeaders, 'Kana');
    if (colKana === -1) colKana = findColIndex(uHeaders, 'ふりがな');
    if (colKana === -1) colKana = findColIndex(uHeaders, 'フリガナ');
    if (colKana === -1) colKana = findColIndex(uHeaders, 'カナ');

    var colLineId = findColIndex(uHeaders, 'LINE_ID');
    if (colLineId === -1) colLineId = findColIndex(uHeaders, 'LINE ID');
    if (colLineId === -1) colLineId = findColIndex(uHeaders, 'LINEID');
    if (colLineId === -1) colLineId = findColIndex(uHeaders, 'ラインID');

    if (colLineId === -1) {
        var newHeaders = uHeaders.slice();
        newHeaders.push('LINE_ID');
        colLineId = newHeaders.length - 1;
        usersSheet.getRange(1, 1, 1, newHeaders.length).setValues([newHeaders]);
        SpreadsheetApp.flush();
    }

    var uData = usersSheet.getRange(2, 1, uLastRow - 1, uHeaders.length).getValues();
    var inboxData = inboxSheet.getRange(2, 1, inboxLastRow - 1, 3).getValues();

    var updatedCount = 0;
    for (var i = 0; i < inboxData.length; i++) {
        var sendText = String(inboxData[i][1] || "").trim();
        var lineId = String(inboxData[i][2] || "").trim();
        if (!lineId || !sendText) continue;

        var matchResult = findMatchingUserRow(uData, colName, colKana, sendText);
        if (matchResult) {
            usersSheet.getRange(matchResult.index + 2, colLineId + 1).setValue(lineId);
            updatedCount++;
        }
    }

    SpreadsheetApp.flush();
    SpreadsheetApp.getUi().alert('同期完了', updatedCount + ' 件のLINE IDをUsersシートに反映しました。', SpreadsheetApp.getUi().ButtonSet.OK);
}
