// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `git rebase -i` insists on an editor for its todo list, and a GUI app has
    // no terminal to open one in. riff points GIT_SEQUENCE_EDITOR at its own
    // executable in this mode (see git::write::sequence_editor_command): git
    // appends the todo path, so argv is `--rebase-todo <plan> <todo>` and the
    // plan the user assembled in the UI is copied over git's generated todo.
    // Handled here, before Tauri starts, so this run never opens a window.
    let args: Vec<String> = std::env::args().collect();
    if args.len() == 4 && args[1] == riff_lib::git::REBASE_TODO_FLAG {
        let copy = std::fs::read(&args[2]).and_then(|plan| std::fs::write(&args[3], plan));
        std::process::exit(match copy {
            Ok(()) => 0,
            // Non-zero makes git abort the rebase instead of running a todo it
            // could not replace — the message reaches git's own output.
            Err(e) => {
                eprintln!("riff: could not write the rebase todo: {e}");
                1
            }
        });
    }
    // AI runs register riff's own executable as Claude Code's PreToolUse
    // hook (see ai::claude_args): the hook JSON comes on stdin, and exit 2
    // blocks the call with the stderr reason shown to the model. Unreadable
    // stdin fails closed through guard_decision.
    if args.len() == 2 && args[1] == riff_lib::ai::AI_BASH_GUARD_FLAG {
        let mut input = String::new();
        let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut input);
        std::process::exit(match riff_lib::ai::guard_decision(&input) {
            Ok(()) => 0,
            Err(reason) => {
                eprintln!("{reason}");
                2
            }
        });
    }
    riff_lib::run()
}
