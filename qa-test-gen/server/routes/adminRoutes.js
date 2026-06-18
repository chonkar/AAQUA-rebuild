import express from 'express';
import { authenticateToken, requireAdminEmail } from '../middleware/auth.js';
import UserActivity from '../models/UserActivity.js';
import { Sequelize } from 'sequelize';

const router = express.Router();

// Summary stats
router.get('/summary', authenticateToken, requireAdminEmail(), async (req, res) => {
    try {
        // Total active users (count distinct email)
        const totalUsers = await UserActivity.count({
            distinct: true,
            col: 'email'
        });

        // Total activities
        const totalActivities = await UserActivity.count();

        // Top users (limit 10)
        const topUsers = await UserActivity.findAll({
            attributes: [
                'email',
                'username',
                'name',
                [Sequelize.fn('COUNT', Sequelize.col('id')), 'count'],
                [Sequelize.fn('MAX', Sequelize.col('created_at')), 'last_active']
            ],
            group: ['email', 'username', 'name'],
            order: [[Sequelize.literal('count'), 'DESC']],
            limit: 10,
            raw: true
        });

        // Activity trends over last 7 days (grouped by day)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const activityTrend = await UserActivity.findAll({
            attributes: [
                [Sequelize.fn('date_trunc', 'day', Sequelize.col('created_at')), 'date'],
                [Sequelize.fn('COUNT', Sequelize.col('id')), 'count']
            ],
            where: {
                created_at: {
                    [Sequelize.Op.gte]: sevenDaysAgo
                }
            },
            group: [Sequelize.fn('date_trunc', 'day', Sequelize.col('created_at'))],
            order: [[Sequelize.fn('date_trunc', 'day', Sequelize.col('created_at')), 'ASC']],
            raw: true
        });

        res.json({
            totalUsers,
            totalActivities,
            topUsers,
            activityTrend
        });
    } catch (error) {
        console.error('[adminRoutes] Failed to fetch usage summary:', error);
        res.status(500).json({ error: 'Failed to fetch usage summary: ' + error.message });
    }
});

// Paginated activity log
router.get('/logs', authenticateToken, requireAdminEmail(), async (req, res) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 20;
        const offset = (page - 1) * limit;
        const search = req.query.search || '';

        const whereClause = {};
        if (search) {
            whereClause[Sequelize.Op.or] = [
                { email: { [Sequelize.Op.iLike]: `%${search}%` } },
                { username: { [Sequelize.Op.iLike]: `%${search}%` } },
                { name: { [Sequelize.Op.iLike]: `%${search}%` } },
                { action: { [Sequelize.Op.iLike]: `%${search}%` } }
            ];
        }

        const { count, rows } = await UserActivity.findAndCountAll({
            where: whereClause,
            order: [['created_at', 'DESC']],
            limit,
            offset
        });

        res.json({
            logs: rows,
            total: count,
            page,
            totalPages: Math.ceil(count / limit)
        });
    } catch (error) {
        console.error('[adminRoutes] Failed to fetch logs:', error);
        res.status(500).json({ error: 'Failed to fetch logs: ' + error.message });
    }
});

export default router;
