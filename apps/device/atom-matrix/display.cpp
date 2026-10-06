#include <Arduino.h>
// Claude 管制室 物理表示灯（M5Stack Atom Matrix）
// Mac Mini のサーバーから USB シリアル（115200bps）で「S <状態> <5時間枠の残り%> <週間枠の残り%>」の1行を受け取る
// （状態は err / wait / run / idle、残りが不明なら -）。
//   異常（err）：25個すべて朱色で点滅。明るさはボタンの設定によらず最大（M5Stack 推奨の上限 20）
//   それ以外  ：左2列＝5時間枠、右2列＝週間枠の残り。2列×5段の10個で、1個 10%（切り上げ）。下から積み上げる
//               色は残り 50% 以上が緑、20% 以上が黄、それ未満が橙。残りが不明なら、その列の一番下を灰色で点ける
//               中央の列の縦3個（2〜4段目）はセッションの状態（稼働中＝緑、入力待ち＝黄、なし＝消灯）
// 45 秒間何も届かなければ、途切れた表示（左上の暗い青の点滅）にする。ボタンで明るさを3段階に切り替える。

#include <Adafruit_NeoPixel.h>

const int LED_PIN = 27;
const int BUTTON_PIN = 39;
const int NUM = 25;
const uint8_t LEVELS[] = {4, 10, 20};
const uint8_t MAX_LEVEL = 20;
const unsigned long STALE_MS = 45000;

Adafruit_NeoPixel px(NUM, LED_PIN, NEO_GRB + NEO_KHZ800);

enum State { OFFLINE, IDLE, RUN, WAIT, ERR };
State state = OFFLINE;
int fiveRemain = -1;  // -1 は不明
int weekRemain = -1;
unsigned long lastMsg = 0;
uint8_t level = 1;
bool lastButton = HIGH;
String line;

void setXY(int x, int y, uint32_t c) { px.setPixelColor(y * 5 + x, c); }

uint32_t remainColor(int r) {
  if (r >= 50) return px.Color(0x43, 0xc5, 0x7f);
  if (r >= 20) return px.Color(0xf5, 0xc4, 0x51);
  return px.Color(0xe8, 0x89, 0x2b);
}

/** 2列×5段の残りグラフ。左下から右下、その上の段……の順に点ける */
void drawBar(int baseX, int remain) {
  if (remain < 0) {
    setXY(baseX, 4, px.Color(0x50, 0x58, 0x68));
    return;
  }
  int dots = (remain + 9) / 10;  // 切り上げ。残り 0% で 0 個
  if (dots > 10) dots = 10;
  uint32_t c = remainColor(remain);
  for (int k = 0; k < dots; k++) setXY(baseX + k % 2, 4 - k / 2, c);
}

void render() {
  unsigned long now = millis();
  px.clear();
  if (state == ERR) {
    px.setBrightness(MAX_LEVEL);
    if ((now / 500) % 2 == 0)
      for (int i = 0; i < NUM; i++) px.setPixelColor(i, px.Color(0xf0, 0x30, 0x20));
    px.show();
    return;
  }
  px.setBrightness(LEVELS[level]);
  if (state == OFFLINE) {
    if ((now / 700) % 2 == 0) setXY(0, 0, px.Color(0x20, 0x30, 0x90));
    px.show();
    return;
  }
  drawBar(0, fiveRemain);
  drawBar(3, weekRemain);
  uint32_t sc = state == RUN ? px.Color(0x43, 0xc5, 0x7f) : state == WAIT ? px.Color(0xf5, 0xc4, 0x51) : 0;
  for (int y = 1; y <= 3; y++) setXY(2, y, sc);
  px.show();
}

int parseRemain(const String& s) {
  if (s.length() == 0 || s == "-") return -1;
  int v = s.toInt();
  return v < 0 ? 0 : v > 100 ? 100 : v;
}

void handleLine(const String& s) {
  if (!s.startsWith("S ")) return;
  String rest = s.substring(2);
  rest.trim();
  int sp1 = rest.indexOf(' ');
  String v = sp1 < 0 ? rest : rest.substring(0, sp1);
  if (v == "err") state = ERR;
  else if (v == "wait") state = WAIT;
  else if (v == "run") state = RUN;
  else if (v == "idle") state = IDLE;
  else return;
  if (sp1 >= 0) {
    String nums = rest.substring(sp1 + 1);
    int sp2 = nums.indexOf(' ');
    fiveRemain = parseRemain(sp2 < 0 ? nums : nums.substring(0, sp2));
    weekRemain = sp2 < 0 ? -1 : parseRemain(nums.substring(sp2 + 1));
  } else {
    fiveRemain = weekRemain = -1;
  }
  lastMsg = millis();
  Serial.println("OK " + rest);
}

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT);
  px.begin();
  render();
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      handleLine(line);
      line = "";
    } else if (c != '\r' && line.length() < 64) {
      line += c;
    }
  }
  if (state != OFFLINE && millis() - lastMsg > STALE_MS) state = OFFLINE;
  bool b = digitalRead(BUTTON_PIN);
  if (b == LOW && lastButton == HIGH) level = (level + 1) % 3;
  lastButton = b;
  render();
  delay(30);
}
