#include <Arduino.h>
// Claude 管制室 物理表示灯（M5Stack Atom Matrix）
// Mac Mini のサーバーから USB シリアル（115200bps）で「S <状態>」の1行を受け取り、5×5 の LED に形で表示する。
//   S err  … 朱の四角（ゆっくり点滅）   S wait … 黄の三角
//   S run  … 緑の丸                      S idle … 中央に暗い点（動いているセッションなし）
// 45 秒間何も届かなければ、途切れた表示（左上の暗い青の点滅）にする。ボタンで明るさを3段階に切り替える。
// Atom Matrix の LED は発熱するため、明るさは M5Stack の推奨（20 以下）に抑える。

#include <Adafruit_NeoPixel.h>

const int LED_PIN = 27;
const int BUTTON_PIN = 39;
const int NUM = 25;
const uint8_t LEVELS[] = {4, 10, 20};
const unsigned long STALE_MS = 45000;

Adafruit_NeoPixel px(NUM, LED_PIN, NEO_GRB + NEO_KHZ800);

enum State { OFFLINE, IDLE, RUN, WAIT, ERR };
State state = OFFLINE;
unsigned long lastMsg = 0;
uint8_t level = 1;
bool lastButton = HIGH;
String line;

// 形（行ごと、左が上位ビット 5 桁）
const uint8_t CIRCLE[5] = {0b01110, 0b11111, 0b11111, 0b11111, 0b01110};
const uint8_t TRIANGLE[5] = {0b00100, 0b01110, 0b01110, 0b11111, 0b11111};
const uint8_t SQUARE[5] = {0b11111, 0b10001, 0b10001, 0b10001, 0b11111};

void drawShape(const uint8_t rows[5], uint32_t color) {
  for (int y = 0; y < 5; y++)
    for (int x = 0; x < 5; x++) px.setPixelColor(y * 5 + x, (rows[y] >> (4 - x)) & 1 ? color : 0);
}

void render() {
  unsigned long now = millis();
  bool blink = (now / 700) % 2 == 0;
  px.clear();
  px.setBrightness(LEVELS[level]);
  switch (state) {
    case RUN: drawShape(CIRCLE, px.Color(0x43, 0xc5, 0x7f)); break;
    case WAIT: drawShape(TRIANGLE, px.Color(0xf5, 0xc4, 0x51)); break;
    case ERR: if (blink || (now / 350) % 2 == 0) drawShape(SQUARE, px.Color(0xf0, 0x6a, 0x43)); break;
    case IDLE: px.setPixelColor(12, px.Color(0x2d, 0x60, 0x6b)); break;
    case OFFLINE: if (blink) px.setPixelColor(0, px.Color(0x20, 0x30, 0x90)); break;
  }
  px.show();
}

void handleLine(const String& s) {
  if (!s.startsWith("S ")) return;
  String v = s.substring(2);
  v.trim();
  if (v == "err") state = ERR;
  else if (v == "wait") state = WAIT;
  else if (v == "run") state = RUN;
  else if (v == "idle") state = IDLE;
  else return;
  lastMsg = millis();
  Serial.println("OK " + v);
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
