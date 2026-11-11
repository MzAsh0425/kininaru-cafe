#!/usr/bin/env python3
"""iPhone ショートカット「きになるカフェに追加」を作って署名する（macOS で実行）

    python3 shortcut/build.py

js/config.js の API_URL を読み込んで、shortcut/きになるカフェに追加.shortcut を作り直す。
API_URL を変えたときは作り直して push すること。

ショートカットの中身:
  1. コード（メンバーID.合言葉ハッシュ）… 取り込み時に聞かれる
  2. 共有された内容（URL/テキスト/Safariのページ）から最初の URL を取り出す
  3. その URL のページを iPhone で読み込む
  4. ページの HTML を本文にして GAS に送る（action=add_page）
  5. 結果を通知で表示
"""
import os
import plistlib
import re
import subprocess
import sys
import tempfile
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
NAME = "きになるカフェに追加"
OUT = os.path.join(HERE, f"{NAME}.shortcut")

config = open(os.path.join(HERE, "..", "js", "config.js"), encoding="utf-8").read()
API_URL = re.search(r'API_URL\s*=\s*"([^"]+)"', config).group(1)

OBJ = "￼"  # 変数を埋め込む位置の文字


def uid():
    return str(uuid.uuid4()).upper()


def output(action_uuid, name):
    return {"OutputUUID": action_uuid, "OutputName": name, "Type": "ActionOutput"}


SHORTCUT_INPUT = {"Type": "ExtensionInput"}


def attachment(value):
    return {"Value": value, "WFSerializationType": "WFTextTokenAttachment"}


def token_string(*parts):
    """文字列と変数を並べたテキスト（変数は OBJ の位置に入る）"""
    text = ""
    ranges = {}
    for p in parts:
        if isinstance(p, str):
            text += p
        else:
            # 位置は UTF-16 単位
            offset = len(text.encode("utf-16-le")) // 2
            ranges[f"{{{offset}, 1}}"] = p
            text += OBJ
    return {"Value": {"string": text, "attachmentsByRange": ranges}, "WFSerializationType": "WFTextTokenString"}


def action(identifier, **params):
    return {"WFWorkflowActionIdentifier": identifier, "WFWorkflowActionParameters": params}


U_CODE, U_LINKS, U_FIRST, U_PAGE, U_ENC_URL, U_ENC_IN, U_POST, U_MSG = (uid() for _ in range(8))

actions = [
    # 0: コード（取り込み時に入力してもらう）
    action("is.workflow.actions.gettext", UUID=U_CODE, WFTextActionText=""),
    # 1-2: 共有された内容から最初の URL
    action("is.workflow.actions.detect.link", UUID=U_LINKS, WFInput=attachment(SHORTCUT_INPUT)),
    action("is.workflow.actions.getitemfromlist", UUID=U_FIRST, WFItemSpecifier="First Item",
           WFInput=attachment(output(U_LINKS, "URL"))),
    # 3: iPhone でページを読み込む
    action("is.workflow.actions.downloadurl", UUID=U_PAGE, WFHTTPMethod="GET",
           WFURL=token_string(output(U_FIRST, "リストからの項目"))),
    # 4-5: URL と共有テキスト（店名などの手がかり）をクエリ用にエンコード
    action("is.workflow.actions.urlencode", UUID=U_ENC_URL, WFInput=token_string(output(U_FIRST, "リストからの項目"))),
    action("is.workflow.actions.urlencode", UUID=U_ENC_IN, WFInput=token_string(SHORTCUT_INPUT)),
    # 6: ページの HTML を GAS に送る
    action("is.workflow.actions.downloadurl", UUID=U_POST, WFHTTPMethod="POST", WFHTTPBodyType="File",
           WFURL=token_string(f"{API_URL}?action=add_page&token=", output(U_CODE, "テキスト"),
                              "&url=", output(U_ENC_URL, "URLエンコードされたテキスト"),
                              "&hint=", output(U_ENC_IN, "URLエンコードされたテキスト")),
           WFRequestVariable=attachment(output(U_PAGE, "URLの内容"))),
    # 7-8: 結果を通知
    action("is.workflow.actions.getvalueforkey", UUID=U_MSG, WFDictionaryKey="message",
           WFInput=attachment(output(U_POST, "URLの内容"))),
    action("is.workflow.actions.notification", WFNotificationActionTitle="きになるカフェ",
           WFNotificationActionBody=token_string(output(U_MSG, "辞書の値")), WFNotificationActionSound=False),
]

shortcut = {
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowClientVersion": "2302.0.4",
    "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4251333119, "WFWorkflowIconGlyphNumber": 59446},
    "WFWorkflowTypes": ["ActionExtension"],
    "WFWorkflowHasShortcutInputVariables": True,
    "WFWorkflowInputContentItemClasses": [
        "WFURLContentItem", "WFStringContentItem", "WFSafariWebPageContentItem", "WFRichTextContentItem",
    ],
    "WFWorkflowOutputContentItemClasses": [],
    "WFWorkflowHasOutputFallback": False,
    # 共有ボタン以外（ショートカットアプリなど）から実行したときはクリップボードの内容を使う
    "WFWorkflowNoInputBehavior": {"Name": "WFWorkflowNoInputBehaviorGetClipboard", "Parameters": {}},
    "WFQuickActionSurfaces": [],
    "WFWorkflowImportQuestions": [{
        "ActionIndex": 0,
        "Category": "Parameter",
        "DefaultValue": "",
        "ParameterKey": "WFTextActionText",
        "Text": "きになるカフェの「あなたの設定」で「コードをコピー」したコードを貼り付けてください",
    }],
    "WFWorkflowActions": actions,
}

with tempfile.TemporaryDirectory() as tmp:
    unsigned = os.path.join(tmp, f"{NAME}.shortcut")
    with open(unsigned, "wb") as f:
        plistlib.dump(shortcut, f, fmt=plistlib.FMT_BINARY)
    r = subprocess.run(["shortcuts", "sign", "--mode", "anyone", "--input", unsigned, "--output", OUT],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"署名に失敗しました: {r.stderr or r.stdout}")
print(f"作成しました: {OUT}")
