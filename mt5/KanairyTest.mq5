//+------------------------------------------------------------------+
//| KanairyTest.mq5  -  Milestone 1 test EA (DEMO ONLY)              |
//| Opens one BUY, holds it, closes it, opens one SELL, closes it.   |
//+------------------------------------------------------------------+
#property strict
#property version "1.00"
#include <Trade/Trade.mqh>

input double InpLots     = 0.01;   // Lot size
input int    InpSLPoints = 500;    // Stop loss (points)
input int    InpTPPoints = 500;    // Take profit (points)
input int    InpHoldSec  = 10;     // Seconds to hold each trade
input long   InpMagic    = 550001; // Magic number

CTrade   trade;
int      stage = 0;
datetime stageTime = 0;

//--- helpers
int StopDistance()
{
   long lvl = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
   return (int)MathMax((long)InpSLPoints, lvl + 10);
}

double LotOk()
{
   double mn = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double st = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double l  = MathMax(InpLots, mn);
   return NormalizeDouble(MathFloor(l / st) * st, 2);
}

void CloseAllMine()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(t == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      if(PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;
      if(trade.PositionClose(t))
         PrintFormat("[KanairyTest] closed #%I64u", t);
      else
         PrintFormat("[KanairyTest] close FAILED #%I64u retcode=%d %s", t, trade.ResultRetcode(), trade.ResultRetcodeDescription());
   }
}

bool OpenOrder(bool buy)
{
   MqlTick tk;
   if(!SymbolInfoTick(_Symbol, &tk)) { Print("[KanairyTest] no tick yet"); return false; }
   double pt = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   int sl = StopDistance();
   int tp = (int)MathMax((long)InpTPPoints, (long)sl);
   bool ok;
   if(buy)
      ok = trade.Buy(LotOk(), _Symbol, tk.ask, tk.ask - sl * pt, tk.ask + tp * pt, "KanairyTest BUY");
   else
      ok = trade.Sell(LotOk(), _Symbol, tk.bid, tk.bid + sl * pt, tk.bid - tp * pt, "KanairyTest SELL");
   PrintFormat("[KanairyTest] %s ok=%d retcode=%d %s", buy ? "BUY" : "SELL", ok, trade.ResultRetcode(), trade.ResultRetcodeDescription());
   return ok;
}

//--- events
int OnInit()
{
   if(AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_REAL)
   {
      Print("[KanairyTest] REAL account detected. This test EA only runs on DEMO. Stopping.");
      return INIT_FAILED;
   }
   SymbolSelect(_Symbol, true);
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(50);
   EventSetTimer(1);
   PrintFormat("[KanairyTest] started on %s. Account mode: %s", _Symbol,
               AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING ? "HEDGING" : "NETTING/other");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }

void OnTimer()
{
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED))
   {
      Print("[KanairyTest] AutoTrading is OFF. Press the AutoTrading button and tick 'Allow Algo Trading' in the EA properties.");
      return;
   }
   int held = (int)(TimeCurrent() - stageTime);
   switch(stage)
   {
      case 0: if(OpenOrder(true))  { stage = 1; stageTime = TimeCurrent(); } break;
      case 1: if(held >= InpHoldSec) { CloseAllMine(); stage = 2; } break;
      case 2: if(OpenOrder(false)) { stage = 3; stageTime = TimeCurrent(); } break;
      case 3: if(held >= InpHoldSec) { CloseAllMine(); stage = 4; Print("[KanairyTest] DONE. Milestone 1 trades complete."); } break;
      default: break;
   }
}
