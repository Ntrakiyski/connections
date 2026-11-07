import type { FormEvent, ReactNode } from "react";

import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { authClient } from "./auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type AuthMode = "sign-in" | "sign-up" | "recovery" | "reset";
export function AuthPage(props: { onSignedIn(): void }): ReactNode {
  const location = useLocation();
  const navigate = useNavigate();
  const token = new URLSearchParams(location.search).get("token") ?? undefined;
  const [mode, setMode] = useState<AuthMode>(location.pathname === "/reset-password" && token ? "reset" : "sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const title = {
    "sign-in": "Sign in to Connections",
    "sign-up": "Create your account",
    recovery: "Reset your password",
    reset: "Choose a new password",
  }[mode];

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const callbackURL = new URL(location.pathname + location.search, window.location.origin).toString();
      if (mode === "sign-in") {
        const result = await authClient.signIn.email({ email, password, callbackURL });
        if (result.error) throw new Error(result.error.message);
        props.onSignedIn();
      } else if (mode === "sign-up") {
        const result = await authClient.signUp.email({ name, email, password, callbackURL });
        if (result.error) throw new Error(result.error.message);
        setMessage("Check your email to verify your account, then sign in.");
        setMode("sign-in");
        setPassword("");
      } else if (mode === "recovery") {
        const result = await authClient.requestPasswordReset({
          email,
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (result.error) throw new Error(result.error.message);
        setMessage("If that account exists, a password reset link has been sent.");
      } else {
        const result = await authClient.resetPassword({ newPassword: password, token });
        if (result.error) throw new Error(result.error.message);
        setMode("sign-in");
        setPassword("");
        navigate("/", { replace: true });
        setMessage("Password updated. Sign in with your new password.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The request failed. Try again.");
    } finally {
      setBusy(false);
    }
  }
  async function resend(): Promise<void> {
    setBusy(true);
    try {
      const result = await authClient.sendVerificationEmail({ email, callbackURL: window.location.href });
      if (result.error) throw new Error(result.error.message);
      setMessage("Check your email for the verification link.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Verification could not be sent.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="unlock-screen">
      <section className="unlock-panel account-panel">
        <h1>{title}</h1>
        <p>One verified account for your companies and workspaces.</p>
        <form onSubmit={(event) => void submit(event)} className="account-form">
          {mode === "sign-up" ? (
            <Label className="field">
              Name
              <Input
                name="name"
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </Label>
          ) : null}
          {mode !== "reset" ? (
            <Label className="field">
              Email
              <Input
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </Label>
          ) : null}
          {mode !== "recovery" ? (
            <Label className="field">
              Password
              <Input
                name="password"
                type="password"
                autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </Label>
          ) : null}
          <Button type="submit" disabled={busy}>
            {busy
              ? "Please wait…"
              : mode === "sign-in"
                ? "Sign in"
                : mode === "sign-up"
                  ? "Create account"
                  : mode === "recovery"
                    ? "Send reset link"
                    : "Update password"}
          </Button>
        </form>
        <p role="status" aria-live="polite">
          {message}
        </p>
        <div className="button-row">
          {mode !== "sign-in" ? (
            <Button
              variant="ghost"
              onClick={() => {
                setMode("sign-in");
                setMessage("");
              }}
            >
              Back to sign in
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setMode("sign-up");
                  setMessage("");
                }}
              >
                Create account
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setMode("recovery");
                  setMessage("");
                }}
              >
                Forgot password?
              </Button>
              <Button variant="ghost" disabled={busy || !email} onClick={() => void resend()}>
                Resend verification
              </Button>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
