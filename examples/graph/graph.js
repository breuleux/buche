#!/usr/bin/env buche -v node

function buche(cfg) {
    console.log(JSON.stringify(cfg));
}

buche({
    command: 'plugin',
    name: 'cytoscape'
});

buche({
    parent: "/",
    tag: 'cytoscape-graph',
    attributes: {
        address: 'graph',
        width: '1000px',
        height: '1000px',
    }
})

buche({
    parent: "/graph",
    command: "configure",
    style: `${__dirname}/graph-style.css`
})

let connList = process.argv.slice(2);
if (connList.length == 0) {
    connList = 'AB BC CA AD DE'.split(' ');
}

let connections = connList.map(pair => pair.split(''));

for (let [from, to] of connections) {
    buche({
        command: 'element',
        parent: '/graph',
        data: {
            source: from,
            target: to
        }
    });
}
