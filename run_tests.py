"""
功能測試腳本 - Drawing-to-3D v0.2 語音系統
執行方式：python run_tests.py（在 backend venv 中）
"""

import asyncio
import json
import struct
import sys
import urllib.request
import urllib.error

BASE_URL = "http://localhost:8000"

PASS = "✓"
FAIL = "✗"
WARN = "⚠"

results = []

def print_result(name, ok, detail=""):
    icon = PASS if ok else FAIL
    status = "PASS" if ok else "FAIL"
    msg = f"  [{icon}] {name}: {status}"
    if detail:
        msg += f"\n       {detail}"
    print(msg)
    results.append((name, ok))

def http_get(path, parse_json=True):
    url = BASE_URL + path
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = resp.read()
            if parse_json:
                data = json.loads(body)
            else:
                data = body.decode(errors="replace")
            return resp.status, data
    except urllib.error.HTTPError as e:
        return e.code, {}
    except Exception as e:
        return None, str(e)

def http_post_json(path, body):
    url = BASE_URL + path
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            body = json.loads(body)
        except Exception:
            body = body.decode(errors="replace")
        return e.code, body
    except Exception as e:
        return None, str(e)

def make_minimal_wav():
    """Build a minimal valid WAV (0.1s silence, 16kHz mono 16-bit)."""
    sample_rate = 16000
    num_channels = 1
    bits_per_sample = 16
    num_samples = 1600  # 0.1 seconds
    data_size = num_samples * num_channels * (bits_per_sample // 8)

    header = struct.pack(
        '<4sI4s4sIHHIIHH4sI',
        b'RIFF',
        36 + data_size,
        b'WAVE',
        b'fmt ',
        16,              # PCM chunk size
        1,               # PCM format
        num_channels,
        sample_rate,
        sample_rate * num_channels * (bits_per_sample // 8),
        num_channels * (bits_per_sample // 8),
        bits_per_sample,
        b'data',
        data_size,
    )
    return header + b'\x00' * data_size

def http_post_multipart(path, file_bytes, filename, extra_fields=None):
    """Send multipart/form-data POST."""
    import uuid
    boundary = uuid.uuid4().hex
    body = b""

    # extra fields
    if extra_fields:
        for key, value in extra_fields.items():
            body += f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()

    # file field
    body += (
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f'Content-Type: audio/wav\r\n\r\n'
    ).encode()
    body += file_bytes
    body += f'\r\n--{boundary}--\r\n'.encode()

    url = BASE_URL + path
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body_resp = e.read()
        try:
            body_resp = json.loads(body_resp)
        except Exception:
            body_resp = body_resp.decode(errors="replace")
        return e.code, body_resp
    except Exception as e:
        return None, str(e)


async def test_websocket(session_id="test-session-001"):
    """Test WebSocket connection and basic message exchange."""
    try:
        import websockets
    except ImportError:
        return None, "websockets package not installed"

    ws_url = f"ws://localhost:8000/ws/conversation/{session_id}"
    try:
        async with websockets.connect(ws_url, open_timeout=5) as ws:
            # Send init_session
            await ws.send(json.dumps({
                "type": "init_session",
                "objects": [
                    {
                        "object_id": "obj-test-001",
                        "object_name": "測試物件",
                        "object_description": "一個測試用的物件",
                        "personality": {
                            "personality_summary": "親切、好奇",
                            "communication_style": "溫和且直接",
                            "scores": {"openness": 4.0, "conscientiousness": 3.5,
                                       "extraversion": 3.0, "agreeableness": 4.5, "neuroticism": 2.0},
                            "object_description": "測試物件",
                            "self_description": "我是測試"
                        },
                        "model_url": ""
                    }
                ],
                "scene_mode": "spatial"
            }))

            # Wait for session_ready response
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=10)
                data = json.loads(msg)
                if data.get("type") == "session_ready":
                    sid = data.get('session_id') or data.get('summary', {}).get('session_id')
                    return True, f"session_ready received, session_id={sid}"
                else:
                    return False, f"unexpected response type: {data.get('type')}, data: {data}"
            except asyncio.TimeoutError:
                return False, "timeout waiting for session_ready"

    except Exception as e:
        return False, str(e)


def main():
    print("=" * 60)
    print("  Drawing-to-3D v0.2 語音系統功能測試")
    print("=" * 60)
    print()

    # ── 1. Health check ──────────────────────────────────────────
    print("【1】基本健康檢查")
    status, data = http_get("/health")
    if status == 200 and data.get("status") == "ok":
        print_result("GET /health", True, f"version={data.get('version')}, status={data.get('status')}")
        if data.get("version") != "0.2.0":
            print(f"       {WARN} 版本不是 0.2.0，是 {data.get('version')}")
    else:
        print_result("GET /health", False, f"status={status}, data={data}")

    # ── 2. Docs page ─────────────────────────────────────────────
    print()
    print("【2】API 文件路由")
    status, body = http_get("/docs", parse_json=False)
    is_html = isinstance(body, str) and "swagger" in body.lower()
    print_result("GET /docs (OpenAPI UI)", status == 200, f"HTTP {status}, HTML={'是' if is_html else '否'}")

    # ── 3. Voice profiles list ────────────────────────────────────
    print()
    print("【3】語音 Profile API")
    status, data = http_get("/api/voice/profiles")
    print_result("GET /api/voice/profiles", status == 200, f"HTTP {status}, data={data}")

    # ── 4. Upload voice sample ────────────────────────────────────
    print()
    print("【4】聲音樣本上傳")
    wav_bytes = make_minimal_wav()
    print(f"       生成測試 WAV：{len(wav_bytes)} bytes (0.1s silence, 16kHz mono)")
    status, data = http_post_multipart(
        "/api/voice/upload-sample",
        wav_bytes,
        "test_voice.wav",
        extra_fields={"object_id": "obj-test-001"}
    )
    print_result("POST /api/voice/upload-sample", status == 200, f"HTTP {status}, data={data}")
    saved_filename = data.get("filename") if isinstance(data, dict) else None

    # ── 5. Voice clone (if upload succeeded) ─────────────────────
    if saved_filename:
        print()
        print("【5】聲音 Clone（建立 Profile）")
        status, data = http_post_json("/api/voice/clone", {
            "object_id": "obj-test-001",
            "object_name": "測試物件",
            "pitch_shift": 0.0,
            "speed": 1.0,
            "energy": 1.0,
            "sample_filename": saved_filename
        })
        print_result("POST /api/voice/clone", status == 200, f"HTTP {status}, data={data}")

        # Verify profile appears in list
        status2, data2 = http_get("/api/voice/profiles")
        profiles = data2.get("profiles", []) if isinstance(data2, dict) else []
        found = any(p.get("object_id") == "obj-test-001" for p in profiles)
        print_result("Profile 出現在 /api/voice/profiles", found,
                     f"共 {len(profiles)} 個 profile")
    else:
        print()
        print(f"  [{WARN}] 跳過 clone 測試（上傳失敗）")

    # ── 6. WebSocket conversation ─────────────────────────────────
    print()
    print("【6】WebSocket 對話連線")
    ok, detail = asyncio.run(test_websocket())
    if ok is None:
        print(f"  [{WARN}] WebSocket 測試跳過：{detail}")
    else:
        print_result("WS /ws/conversation/{id} init_session", ok, detail)

    # ── 7. Scene mode change ──────────────────────────────────────
    if ok:
        print()
        print("【7】場景模式切換（透過 WebSocket）")
        async def test_scene_mode():
            import websockets
            ws_url = "ws://localhost:8000/ws/conversation/test-scene-001"
            try:
                async with websockets.connect(ws_url, open_timeout=5) as ws:
                    # Init
                    await ws.send(json.dumps({
                        "type": "init_session",
                        "objects": [{
                            "object_id": "obj-s-001", "object_name": "場景測試",
                            "object_description": "測試場景切換",
                            "personality": {"personality_summary": "冷靜",
                                           "communication_style": "直接",
                                           "scores": {"openness":3,"conscientiousness":3,
                                                      "extraversion":3,"agreeableness":3,"neuroticism":3},
                                           "object_description":"test","self_description":"test"},
                            "model_url": ""
                        }],
                        "scene_mode": "spatial"
                    }))
                    msg = await asyncio.wait_for(ws.recv(), timeout=10)
                    data = json.loads(msg)
                    if data.get("type") != "session_ready":
                        return False, f"init failed: {data}"

                    # Switch scene
                    await ws.send(json.dumps({"type": "scene_mode", "mode": "abstract"}))
                    msg = await asyncio.wait_for(ws.recv(), timeout=5)
                    data = json.loads(msg)
                    if data.get("type") == "scene_mode_changed":
                        return True, f"mode={data.get('mode')}"
                    else:
                        return False, f"unexpected: {data}"
            except Exception as e:
                return False, str(e)

        ok2, detail2 = asyncio.run(test_scene_mode())
        print_result("場景模式切換 spatial→abstract", ok2, detail2)

    # ── 8. Intro request ──────────────────────────────────────────
    print()
    print("【8】request_intro 流程")
    async def test_intro():
        try:
            import websockets
        except ImportError:
            return None, "websockets not installed"
        ws_url = "ws://localhost:8000/ws/conversation/test-intro-001"
        try:
            async with websockets.connect(ws_url, open_timeout=5) as ws:
                await ws.send(json.dumps({
                    "type": "init_session",
                    "objects": [{
                        "object_id": "obj-intro-001",
                        "object_name": "記憶茶杯",
                        "object_description": "外婆留下的茶杯",
                        "personality": {
                            "personality_summary": "溫柔、懷舊、富有情感",
                            "communication_style": "用比喻和詩意的語言說話",
                            "scores": {"openness": 4.5, "conscientiousness": 3.0,
                                       "extraversion": 2.5, "agreeableness": 5.0, "neuroticism": 3.0},
                            "object_description": "外婆留下的茶杯",
                            "self_description": "我是個喜歡回憶的人"
                        },
                        "model_url": ""
                    }],
                    "scene_mode": "spatial"
                }))
                await asyncio.wait_for(ws.recv(), timeout=10)  # session_ready

                # Request intro for the object
                await ws.send(json.dumps({
                    "type": "request_intro",
                    "object_id": "obj-intro-001"
                }))

                # Collect responses (intro_text, intro_complete, or error)
                responses = []
                deadline = asyncio.get_event_loop().time() + 20
                while asyncio.get_event_loop().time() < deadline:
                    try:
                        msg = await asyncio.wait_for(ws.recv(), timeout=15)
                        data = json.loads(msg)
                        responses.append(data)
                        if data.get("type") in ("intro_text", "intro_complete", "error"):
                            break
                    except asyncio.TimeoutError:
                        break

                if responses:
                    last = responses[-1]
                    t = last.get("type")
                    if t == "intro_text":
                        text = last.get("text", "")[:80]
                        return True, f"intro_text received: 「{text}...」"
                    elif t == "intro_complete":
                        return True, f"intro_complete (phase={last.get('phase')})"
                    elif t == "error":
                        return False, f"server error: {last.get('message')}"
                    else:
                        return True, f"received {len(responses)} msgs, last type={t}"
                else:
                    return False, "no response received"
        except Exception as e:
            return False, str(e)

    ok3, detail3 = asyncio.run(test_intro())
    if ok3 is None:
        print(f"  [{WARN}] 跳過：{detail3}")
    else:
        print_result("request_intro → LLM 回應", ok3, detail3)

    # ── Summary ───────────────────────────────────────────────────
    print()
    print("=" * 60)
    passed = sum(1 for _, ok in results if ok)
    total = len(results)
    print(f"  測試結果：{passed}/{total} 通過")
    if passed == total:
        print(f"  {PASS} 全部通過！")
    else:
        failed = [name for name, ok in results if not ok]
        print(f"  {FAIL} 失敗項目：{', '.join(failed)}")
    print("=" * 60)


if __name__ == "__main__":
    main()
