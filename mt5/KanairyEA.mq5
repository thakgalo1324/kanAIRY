//+------------------------------------------------------------------+
//| KanairyEA.mq5                                                    |
//| The "hands" of Kanairy. Talks to the Kanairy server on this VPS   |
//| (http://127.0.0.1:PORT). Sends closed candles and open positions,|
//| receives orders to open or close, reports fills back.            |
//| Every order carries a stop loss.                                 |
//+------------------------------------------------------------------+
#property strict
#property version   "1.00"
#property description "Kanairy bridge EA. Needs the Kanairy server running."
#include <Trade/Trade.mqh>

input string InpToken     = "";      // Token printed by the Kanairy server (Launch MT5 fills it in)
input string InpHost      = "127.0.0.1"; // Bridge address (each person on a shared server gets their own)
input int    InpPort      = 80;      // Bridge port (MetaTrader only reaches the standard web ports, so this is 80)
input int    InpPollMs     = 150;     // How often to talk to the server (ms). Lower is faster.
input int    InpBars      = 300;     // Closed candles sent to the strategy
input long   InpMagic     = 550002;  // Magic number
input int    InpDeviation = 50;      // Max slippage (points)
input bool   InpAllowLive = false;   // Allow trading on a REAL account

CTrade   trade;
datetime g_lastBarSent = 0;
bool     g_online      = false;
string   g_status      = "starting";
int      g_fail        = 0;

string Base() { return InpPort == 80 ? "http://" + InpHost : "http://" + InpHost + ":" + IntegerToString(InpPort); }
string Url(const string path) { return Base() + path; }

//--- HTTP --------------------------------------------------------------
bool Post(const string path, const string body, string &reply)
{
   char data[], res[];
   string rh;
   int n = StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(n > 0) ArrayResize(data, n - 1);
   string headers = "Content-Type: application/json\r\nX-Token: " + InpToken + "\r\n";
   ResetLastError();
   int code = WebRequest("POST", Url(path), headers, 2000, data, res, rh);
   if(code == -1)
   {
      int e = GetLastError();
      if(e == 4014 || e == 4060)
         g_status = "Allow " + Base() + " in Tools > Options > Expert Advisors > WebRequest";
      else
         g_status = "bridge offline (error " + IntegerToString(e) + ")";
      return false;
   }
   reply = CharArrayToString(res, 0, WHOLE_ARRAY, CP_UTF8);
   if(code == 401) { g_status = "wrong token"; return false; }
   if(code != 200) { g_status = "bridge error " + IntegerToString(code); return false; }
   return true;
}

//--- tiny JSON helpers (the bridge answers flat objects) ---------------
string JStr(const string obj, const string key)
{
   string k = "\"" + key + "\":\"";
   int p = StringFind(obj, k);
   if(p < 0) return "";
   p += StringLen(k);
   int q = StringFind(obj, "\"", p);
   if(q < 0) return "";
   return StringSubstr(obj, p, q - p);
}

double JNum(const string obj, const string key)
{
   string k = "\"" + key + "\":";
   int p = StringFind(obj, k);
   if(p < 0) return 0.0;
   p += StringLen(k);
   int e = p;
   int L = StringLen(obj);
   while(e < L)
   {
      ushort ch = StringGetCharacter(obj, e);
      if(ch == ',' || ch == '}') break;
      e++;
   }
   return StringToDouble(StringSubstr(obj, p, e - p));
}

//--- trading -----------------------------------------------------------
bool Mine(const ulong ticket)
{
   if(!PositionSelectByTicket(ticket)) return false;
   return PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == InpMagic;
}

void CloseAllMine()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(t == 0 || !Mine(t)) continue;
      trade.PositionClose(t);
   }
}

double NormLots(double l)
{
   double mn = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double mx = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double st = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(st <= 0) st = 0.01;
   l = MathFloor(l / st + 1e-9) * st;
   l = MathMax(mn, MathMin(mx, l));
   return NormalizeDouble(l, 2);
}

void OpenOrder(const bool buy, const double lots, const double slDist, const double tpDist, const double tgDist = 0, const double trDist = 0)
{
   double pt  = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   double minD = (double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * pt + pt * 5;
   double sd  = MathMax(slDist, minD);
   double td  = tpDist > 0 ? MathMax(tpDist, minD) : 0;
   double px  = buy ? SymbolInfoDouble(_Symbol, SYMBOL_ASK) : SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(px <= 0) return;
   double sl = NormalizeDouble(buy ? px - sd : px + sd, _Digits);
   double tp = td > 0 ? NormalizeDouble(buy ? px + td : px - td, _Digits) : 0;
   // Ratchet trades carry their target and step in the comment ("KT<target>,<step>"), so no state is lost on a restart.
   string cm = (tgDist > 0 && trDist > 0) ? StringFormat("KT%.3f,%.3f", tgDist, trDist) : "Kanairy";
   bool ok = buy ? trade.Buy(NormLots(lots), _Symbol, px, sl, tp, cm)
                 : trade.Sell(NormLots(lots), _Symbol, px, sl, tp, cm);
   if(!ok)
   {
      string m = StringFormat("{\"k\":\"sys\",\"text\":\"%s failed: %s\"}", buy ? "BUY" : "SELL", trade.ResultRetcodeDescription());
      string r; Post("/event", m, r);
   }
}

void RunCommands(const string reply)
{
   int s = StringFind(reply, "\"cmds\":[");
   if(s < 0) return;
   s += 8;
   int e = StringFind(reply, "]", s);
   if(e < 0) return;
   string list = StringSubstr(reply, s, e - s);
   int pos = 0;
   while(true)
   {
      int a = StringFind(list, "{", pos);
      if(a < 0) break;
      int b = StringFind(list, "}", a);
      if(b < 0) break;
      string o = StringSubstr(list, a, b - a + 1);
      pos = b + 1;
      string act = JStr(o, "a");
      if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED))
      {
         g_status = "AutoTrading is OFF";
         continue;
      }
      if(act == "buy")       OpenOrder(true,  JNum(o, "lots"), JNum(o, "sl"), JNum(o, "tp"), JNum(o, "tg"), JNum(o, "tr"));
      else if(act == "sell") OpenOrder(false, JNum(o, "lots"), JNum(o, "sl"), JNum(o, "tp"), JNum(o, "tg"), JNum(o, "tr"));
      else if(act == "close"){ ulong t = (ulong)JNum(o, "t"); if(Mine(t)) trade.PositionClose(t); }
      else if(act == "closeall") CloseAllMine();
   }
}


//--- ratchet: once price passes the target, keep the trade open and raise the stop a step at a time ---
void TrailPositions()
{
   double pt   = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   double minD = (double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * pt + pt * 5;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(t == 0 || !Mine(t)) continue;
      string cm = PositionGetString(POSITION_COMMENT);
      if(StringSubstr(cm, 0, 2) != "KT") continue;
      string parts[];
      if(StringSplit(StringSubstr(cm, 2), ',', parts) != 2) continue;
      double tg = StringToDouble(parts[0]), tr = StringToDouble(parts[1]);
      if(tg <= 0 || tr <= 0) continue;
      bool   buy   = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY;
      double entry = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl    = PositionGetDouble(POSITION_SL);
      double px    = buy ? SymbolInfoDouble(_Symbol, SYMBOL_BID) : SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      if(px <= 0) continue;
      double m = buy ? px - entry : entry - px;     // how far the trade is in profit
      if(m < tg) continue;                           // target not reached yet: normal stop applies
      double steps = MathFloor((m - tg) / tr + 1e-9);
      double lock  = tg - tr + steps * tr;           // profit to protect
      double want  = buy ? entry + lock : entry - lock;
      want = buy ? MathMin(want, px - minD) : MathMax(want, px + minD);
      want = NormalizeDouble(want, _Digits);
      bool better = buy ? (sl == 0 || want > sl + pt) : (sl == 0 || want < sl - pt);
      if(better) trade.PositionModify(t, want, PositionGetDouble(POSITION_TP));
   }
}

//--- sync with the app ------------------------------------------------
string PeriodText()
{
   string p = EnumToString(_Period);
   StringReplace(p, "PERIOD_", "");
   return p;
}

string PositionsJson()
{
   string out = "[";
   bool first = true;
   for(int i = 0; i < PositionsTotal(); i++)
   {
      ulong t = PositionGetTicket(i);
      if(t == 0 || !Mine(t)) continue;
      if(!first) out += ",";
      first = false;
      out += StringFormat("[%I64u,%d,%.2f,%s,%s,%s,%.2f]", t, (int)PositionGetInteger(POSITION_TYPE),
                          PositionGetDouble(POSITION_VOLUME),
                          DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), _Digits),
                          DoubleToString(PositionGetDouble(POSITION_SL), _Digits),
                          DoubleToString(PositionGetDouble(POSITION_TP), _Digits),
                          PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP));
   }
   return out + "]";
}

string BarsJson(datetime &lastClosed)
{
   MqlRates r[];
   ArraySetAsSeries(r, false);
   int n = CopyRates(_Symbol, _Period, 1, InpBars, r);   // shift 1 = last CLOSED candle
   if(n < 30) return "";
   lastClosed = r[n - 1].time;
   string out = "[";
   for(int i = 0; i < n; i++)
   {
      if(i > 0) out += ",";
      out += StringFormat("[%I64d,%s,%s,%s,%s,%I64d]", (long)r[i].time,
                          DoubleToString(r[i].open, _Digits), DoubleToString(r[i].high, _Digits),
                          DoubleToString(r[i].low, _Digits), DoubleToString(r[i].close, _Digits), r[i].tick_volume);
   }
   return out + "]";
}

void Sync()
{
   bool hedge = AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING;
   string body = StringFormat("{\"sym\":\"%s\",\"tf\":\"%s\",\"bid\":%s,\"ask\":%s,\"bal\":%.2f,\"eq\":%.2f,\"spread\":%d,\"hedge\":%s,\"cid\":\"%I64d\",\"pos\":%s",
                              _Symbol, PeriodText(),
                              DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_BID), _Digits),
                              DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_ASK), _Digits),
                              AccountInfoDouble(ACCOUNT_BALANCE), AccountInfoDouble(ACCOUNT_EQUITY),
                              (int)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD), hedge ? "true" : "false", (long)ChartID(), PositionsJson());
   datetime lastClosed = 0;
   datetime curBar = iTime(_Symbol, _Period, 1);
   bool sendBars = (curBar != 0 && curBar != g_lastBarSent);
   if(sendBars)
   {
      string bars = BarsJson(lastClosed);
      if(bars != "") body += StringFormat(",\"barT\":%I64d,\"bars\":%s", (long)lastClosed, bars);
      else sendBars = false;
   }
   body += "}";
   string reply;
   if(!Post("/sync", body, reply))
   {
      g_online = false;
      g_fail++;
      return;
   }
   if(StringFind(reply, "\"ignore\"") >= 0) { g_status = "ignored: the app trades a different symbol. Remove this EA from this chart."; return; }
   if(StringFind(reply, "\"dup\":true") >= 0)   { g_status = "idle: another chart already runs Kanairy. Remove this EA."; return; }
   g_online = true;
   g_fail = 0;
   if(sendBars) g_lastBarSent = curBar;
   bool run = StringFind(reply, "\"run\":true") >= 0;
   if(StringFind(reply, "\"want\":true") >= 0) g_lastBarSent = 0;   // app asked for fresh candles
   g_status = run ? "running" : "connected, waiting for Start";
   RunCommands(reply);
}

//--- events ------------------------------------------------------------
void OnTradeTransaction(const MqlTradeTransaction &t, const MqlTradeRequest &rq, const MqlTradeResult &rs)
{
   if(t.type != TRADE_TRANSACTION_DEAL_ADD) return;
   if(!HistoryDealSelect(t.deal)) return;
   if(HistoryDealGetInteger(t.deal, DEAL_MAGIC) != InpMagic) return;
   if(HistoryDealGetString(t.deal, DEAL_SYMBOL) != _Symbol) return;
   long entry = HistoryDealGetInteger(t.deal, DEAL_ENTRY);
   long type  = HistoryDealGetInteger(t.deal, DEAL_TYPE);
   double lots = HistoryDealGetDouble(t.deal, DEAL_VOLUME);
   double price = HistoryDealGetDouble(t.deal, DEAL_PRICE);
   string r;
   if(entry == DEAL_ENTRY_IN)
   {
      string side = (type == DEAL_TYPE_BUY) ? "buy" : "sell";
      Post("/event", StringFormat("{\"k\":\"open\",\"side\":\"%s\",\"lots\":%.2f,\"price\":%s}", side, lots, DoubleToString(price, _Digits)), r);
   }
   else if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY)
   {
      string side = (type == DEAL_TYPE_SELL) ? "buy" : "sell";   // a sell deal closes a buy
      double pr = HistoryDealGetDouble(t.deal, DEAL_PROFIT) + HistoryDealGetDouble(t.deal, DEAL_SWAP) + HistoryDealGetDouble(t.deal, DEAL_COMMISSION);
      Post("/event", StringFormat("{\"k\":\"close\",\"side\":\"%s\",\"lots\":%.2f,\"price\":%s,\"profit\":%.2f}", side, lots, DoubleToString(price, _Digits), pr), r);
   }
}

//--- lifecycle ---------------------------------------------------------
int OnInit()
{
   if(StringLen(InpToken) < 8)
   {
      Print("[Kanairy] Token is empty. Copy it from the Kanairy app: Settings > EA token.");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_REAL && !InpAllowLive)
   {
      Print("[Kanairy] REAL account detected. Set InpAllowLive=true to trade it. Stopping.");
      return INIT_FAILED;
   }
   SymbolSelect(_Symbol, true);
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpDeviation);
   EventSetMillisecondTimer(MathMax(50, InpPollMs));
   Print("[Kanairy] EA ready on ", _Symbol, " ", PeriodText());
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   Comment("");
}

void OnTimer()
{
   TrailPositions();
   Sync();
   Comment("KANAIRY  |  ", g_status, "\n", _Symbol, " ", PeriodText());
}

// A new price also triggers a sync (at most every 50 ms), so reactions follow the market, not just the timer.
ulong g_lastTickSync = 0;
void OnTick()
{
   ulong now = GetTickCount64();
   if(now - g_lastTickSync < 50) return;
   g_lastTickSync = now;
   TrailPositions();
   Sync();
}
