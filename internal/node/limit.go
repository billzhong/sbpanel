package node

import (
	"context"
	"net"

	"github.com/sagernet/sing/common/buf"
	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"
	"golang.org/x/time/rate"
)

// wait blocks until n bytes are allowed, in chunks no larger than the burst.
func wait(ctx context.Context, l *rate.Limiter, n int) error {
	if l == nil || n <= 0 {
		return nil
	}
	b := l.Burst()
	for n > 0 {
		k := min(n, b)
		if err := l.WaitN(ctx, k); err != nil {
			return err
		}
		n -= k
	}
	return nil
}

// limitedConn throttles reads (client upload) and writes (client download).
type limitedConn struct {
	net.Conn
	ctx         context.Context
	read, write *rate.Limiter
}

func (c *limitedConn) Read(p []byte) (int, error) {
	if c.read != nil && len(p) > c.read.Burst() {
		p = p[:c.read.Burst()]
	}
	n, err := c.Conn.Read(p)
	if werr := wait(c.ctx, c.read, n); werr != nil && err == nil {
		err = werr
	}
	return n, err
}

func (c *limitedConn) Write(p []byte) (int, error) {
	if err := wait(c.ctx, c.write, len(p)); err != nil {
		return 0, err
	}
	return c.Conn.Write(p)
}

type limitedPacketConn struct {
	N.PacketConn
	ctx         context.Context
	read, write *rate.Limiter
}

func (c *limitedPacketConn) ReadPacket(b *buf.Buffer) (M.Socksaddr, error) {
	dst, err := c.PacketConn.ReadPacket(b)
	if err == nil {
		err = wait(c.ctx, c.read, b.Len())
	}
	return dst, err
}

func (c *limitedPacketConn) WritePacket(b *buf.Buffer, dst M.Socksaddr) error {
	if err := wait(c.ctx, c.write, b.Len()); err != nil {
		b.Release()
		return err
	}
	return c.PacketConn.WritePacket(b, dst)
}
