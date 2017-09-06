// Multiplex the output of multiple commands into the same buche session.
// Each command's output can be nested into its own tab with the syntax
// tab_name:command.

// buche -c "node multiplex.js 'demo:python -u demo.py' 'plot:python -u plot.py' 'repl:python3 -u pyrepl.py'"

let {spawn} = require('child_process');

let commands = process.argv.slice(2);
let targets = {}

process.stdin.setEncoding('utf8')
process.stdin.on('data', sdata => {
    for (let line of sdata.split('\n')) {
        if (!line) continue;
        // We dispatch the command to the proper process
        // based on the top level tab it came from. If multiple
        // processes have the same top level tab, the last one
        // will get all the input.
        let data = JSON.parse(line);
        let [_, tab, ...rest] = data.path.split('/')
        data.path = '/' + rest.join('/')
        targets[tab].stdin.write(JSON.stringify(data) + '\n')
    }
})

for (command_spec of commands) {
    let [tab, command] = command_spec.split(':')
    if (!command) {
        command = tab
        tab = 'default'
    }
    let cmd = spawn(command, {shell: true, stdio: 'pipe'})
    targets[tab] = cmd
    cmd.stdout.setEncoding('utf8')
    cmd.stdout.on('data', sdata => {
        for (let line of sdata.split('\n')) {
            if (!line) continue;
            // We fudge the path to nest all of a command's
            // output in the same tab.
            let data = JSON.parse(line);
            data.path = '/' + tab + data.path;
            console.log(JSON.stringify(data));
        }
    })
}
