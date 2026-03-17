import { Clock, Mic, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import SessionCredits from "./SessionCredits";

interface WelcomeBriefingProps {
  onBegin: () => void;
  isConfigured: boolean;
  onHoverBegin?: () => void;
  hasRestarted?: boolean;
}

const WelcomeBriefing = ({ onBegin, isConfigured, onHoverBegin, hasRestarted }: WelcomeBriefingProps) => (
  <div className="animate-fade-in-up flex flex-col items-center gap-5 px-4 sm:px-6 text-center">
    <h2 className="font-outfit text-lg sm:text-xl font-semibold text-foreground">
      Welcome to Your Onboarding Session
    </h2>
    <ul className="flex flex-col gap-3 text-left">
      <li className="flex items-center gap-3">
        <Clock className="h-5 w-5 shrink-0 text-primary" />
        <span className="font-inter text-sm text-muted-foreground">
          This takes about 10 minutes — have your business details ready
        </span>
      </li>
      <li className="flex items-center gap-3">
        <Mic className="h-5 w-5 shrink-0 text-primary" />
        <span className="font-inter text-sm text-muted-foreground">
          Check your mic and speaker before starting
        </span>
      </li>
      <li className="flex items-center gap-3">
        <MessageSquare className="h-5 w-5 shrink-0 text-primary" />
        <span className="font-inter text-sm text-muted-foreground">
          Answer clearly and concisely — every word is captured
        </span>
      </li>
    </ul>
    {!isConfigured && (
      <div className="w-full max-w-md rounded-2xl border border-border/50 bg-card/50 px-3 sm:px-6 py-5 text-center backdrop-blur-xl">
        <p className="font-inter text-sm text-muted-foreground">
          Our AI consultant is temporarily unavailable. Please check back shortly.
        </p>
      </div>
    )}
    <Button
      onClick={onBegin}
      onMouseEnter={onHoverBegin}
      onFocus={onHoverBegin}
      disabled={!isConfigured}
      className="mt-1 min-h-[48px] min-w-[160px] sm:min-w-[200px] bg-gradient-to-r from-primary to-primary-glow font-outfit text-base font-semibold shadow-[0_0_20px_hsl(var(--primary)/0.25)] hover:shadow-[0_0_30px_hsl(var(--primary)/0.4)] hover:scale-[1.02] active:scale-[0.97]"
      style={{ transition: "all 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55)" }}
    >
      Begin
    </Button>
    <SessionCredits hasRestarted={hasRestarted ?? false} variant="welcome" />
  </div>
);

export default WelcomeBriefing;
