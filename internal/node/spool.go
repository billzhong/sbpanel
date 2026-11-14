package node

import (
	"encoding/binary"
	"errors"
	"time"

	bolt "go.etcd.io/bbolt"
	"google.golang.org/protobuf/proto"

	"sbpanel/internal/pb"
)

var (
	bReports = []byte("reports")
	bMeta    = []byte("meta")
	kSeq     = []byte("seq")
)

// Spool is the durable outbox for traffic reports: every report is written here
// before it is sent and removed only after the master acknowledges its seq.
type Spool struct {
	db         *bolt.DB
	maxReports int
}

func OpenSpool(path string, maxReports int) (*Spool, error) {
	db, err := bolt.Open(path, 0o600, &bolt.Options{Timeout: 5 * time.Second})
	if err != nil {
		return nil, err
	}
	err = db.Update(func(tx *bolt.Tx) error {
		if _, err := tx.CreateBucketIfNotExists(bReports); err != nil {
			return err
		}
		_, err := tx.CreateBucketIfNotExists(bMeta)
		return err
	})
	if err != nil {
		db.Close()
		return nil, err
	}
	return &Spool{db: db, maxReports: maxReports}, nil
}

func (s *Spool) Close() error { return s.db.Close() }

func itob(v uint64) []byte {
	b := make([]byte, 8)
	binary.BigEndian.PutUint64(b, v)
	return b
}

// Append assigns the next seq and stores the report.
func (s *Spool) Append(r *pb.TrafficReport) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		meta := tx.Bucket(bMeta)
		var seq uint64
		if v := meta.Get(kSeq); v != nil {
			seq = binary.BigEndian.Uint64(v)
		}
		seq++
		r.Seq = seq
		b, err := proto.Marshal(r)
		if err != nil {
			return err
		}
		if err := meta.Put(kSeq, itob(seq)); err != nil {
			return err
		}
		return tx.Bucket(bReports).Put(itob(seq), b)
	})
}

var ErrEmpty = errors.New("spool empty")

// Oldest returns the report with the smallest seq.
func (s *Spool) Oldest() (*pb.TrafficReport, error) {
	var r *pb.TrafficReport
	err := s.db.View(func(tx *bolt.Tx) error {
		k, v := tx.Bucket(bReports).Cursor().First()
		if k == nil {
			return ErrEmpty
		}
		r = &pb.TrafficReport{}
		return proto.Unmarshal(v, r)
	})
	return r, err
}

func (s *Spool) Delete(seq uint64) error {
	return s.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(bReports).Delete(itob(seq)) })
}

func (s *Spool) Len() int {
	n := 0
	s.db.View(func(tx *bolt.Tx) error {
		n = tx.Bucket(bReports).Stats().KeyN
		return nil
	})
	return n
}

// Compact folds the oldest reports together when the spool is over its limit
// (master unreachable for a long time), trading time resolution for zero loss.
// The merged report takes the newest seq of the group, which the master has not
// seen yet because reports are pushed strictly in order.
func (s *Spool) Compact(group int) (bool, error) {
	if s.maxReports <= 0 || s.Len() <= s.maxReports {
		return false, nil
	}
	return true, s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bReports)
		c := b.Cursor()
		var rs []*pb.TrafficReport
		var keys [][]byte
		k, v := c.First()
		// skip the head: it may be in flight right now
		if k != nil {
			k, v = c.Next()
		}
		for ; k != nil && len(rs) < group; k, v = c.Next() {
			r := &pb.TrafficReport{}
			if err := proto.Unmarshal(v, r); err != nil {
				return err
			}
			rs = append(rs, r)
			keys = append(keys, append([]byte(nil), k...))
		}
		if len(rs) < 2 {
			return nil
		}
		m := mergeReports(rs)
		m.Seq = rs[len(rs)-1].Seq
		m.BootId = rs[len(rs)-1].BootId
		for _, k := range keys[:len(keys)-1] {
			if err := b.Delete(k); err != nil {
				return err
			}
		}
		out, err := proto.Marshal(m)
		if err != nil {
			return err
		}
		return b.Put(keys[len(keys)-1], out)
	})
}
