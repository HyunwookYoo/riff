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
    riff_lib::run()
}
