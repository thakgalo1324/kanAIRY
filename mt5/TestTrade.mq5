//+------------------------------------------------------------------+
//| TestTrade.mq5  -  places ONE random trade (buy or sell), once.   |
//| Only to prove that MT5 on this machine can trade. DEMO ONLY.     |
//+------------------------------------------------------------------+
#property strict
#property version "1.00"
#include <Trade/Trade.mqh>

input double InpLots  = 0.01;   // Lot size
input double InpSlUsd = 4.0;    // Stop loss distance in price units (gold: $)
input double InpTpUsd = 4.0;    // Take profit distance in price units
input long   InpMagic = 990001; // Magic number

CTrade trade;
bool   g_done = false;

int OnInit()
{
   if(AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_REAL)
   {
      Alert("TestTrade: this is a REAL account. Refusing to trade.");
      return INIT_FAILED;
   }
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(100);
   trade.SetTypeFillingBySymbol(_Symbol);
   MathSrand((int)(GetTickCount() ^ (uint)TimeLocal()));
   EventSetTimer(2);
   Comment("TestTrade: waiting to place one test trade...");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

bool HaveMine()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(t == 0) continue;
      if(PositionGetInteger(POSITION_MAGIC) == InpMagic && PositionGetString(POSITION_SYMBOL) == _Symbol) return true;
   }
   return false;
}

void OnTimer()
{
   if(g_done) return;

   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))
   { Comment("TestTrade: Algo Trading is OFF in MT5. Click the Algo Trading button so it turns green."); return; }
   if(!MQLInfoInteger(MQL_TRADE_ALLOWED))
   { Comment("TestTrade: trading is not allowed for this EA. Press F7 on the chart > Common tab > tick Allow Algo Trading."); return; }
   if(!AccountInfoInteger(ACCOUNT_TRADE_ALLOWED))
   { Comment("TestTrade: the broker does not allow trading on this account."); return; }
   if(HaveMine()) { g_done = true; Comment("TestTrade: a test trade is already open. Done."); return; }

   double pt   = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   double minD = (double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * pt + pt * 5;
   double slD  = MathMax(InpSlUsd, minD);
   double tpD  = MathMax(InpTpUsd, minD);
   double ask  = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid  = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(ask <= 0 || bid <= 0) { Comment("TestTrade: no price yet."); return; }

   bool   buy  = (MathRand() % 2 == 0);
   double sl   = NormalizeDouble(buy ? ask - slD : bid + slD, _Digits);
   double tp   = NormalizeDouble(buy ? ask + tpD : bid - tpD, _Digits);
   double mn   = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double lots = MathMax(mn, InpLots);

   bool ok = buy ? trade.Buy(lots, _Symbol, 0, sl, tp, "TestTrade")
                 : trade.Sell(lots, _Symbol, 0, sl, tp, "TestTrade");
   uint rc = trade.ResultRetcode();
   if(ok && (rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_PLACED || rc == TRADE_RETCODE_DONE_PARTIAL))
   {
      g_done = true;
      string m = StringFormat("TestTrade: %s %.2f %s placed OK (ticket %I64u). MT5 can trade.", buy ? "BUY" : "SELL", lots, _Symbol, trade.ResultOrder());
      Print(m); Comment(m);
   }
   else
   {
      string m = StringFormat("TestTrade: order FAILED, code %u: %s. Trying again in 2 seconds.", rc, trade.ResultRetcodeDescription());
      Print(m); Comment(m);
   }
}
